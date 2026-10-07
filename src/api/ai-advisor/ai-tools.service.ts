import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AccountsService } from '../accounts/accounts.service';
import { BudgetsService } from '../budgets/budgets.service';
import { CategoriesService } from '../categories/categories.service';
import { GoalsService } from '../goals/goals.service';
import { InvestmentsService } from '../investments/investments.service';
import { LoansService } from '../loans/loans.service';
import { RecurringService } from '../recurring/recurring.service';
import { ReportsService } from '../reports/reports.service';
import { TransactionsService } from '../transactions/transactions.service';
import { SpacesService } from '../spaces/spaces.service';
import { convertAmount, getRate } from 'src/common/currency/currency.data';
import {
  AI_AT_TOOLS,
  AI_SLASH_COMMANDS,
  SUPPORTED_ACTION_TYPES,
} from './ai-command-catalog';
import { CONTAINER_TYPES } from '../accounts/dto/create-account.dto';
import {
  ProposalContext,
  repairReferenceIds,
  validateTransactionProposal,
} from './transaction-proposal';
import {
  effectiveTimeZone,
  normalizeIsoDate,
  prefersMonthFirst,
  todayInTimeZone,
  zonedNow,
} from './user-dates';

export type AiUserProfile = {
  first_name: string | null;
  base_currency: string;
  timezone: string;
  locale: string | null;
  today: string;
  now_local: string;
  weekday: string;
  month_first_dates: boolean;
};

const TRANSACTION_ACTIONS = new Set([
  'create_transaction',
  'update_transaction',
  'create_recurring',
  'update_recurring',
]);

const CONTAINER_TYPE_ALIASES: Record<string, (typeof CONTAINER_TYPES)[number]> = {
  savings: 'bank',
  saving: 'bank',
  'savings account': 'bank',
  'savings_account': 'bank',
  checking: 'bank',
  current: 'bank',
  'current account': 'bank',
  debit: 'bank',
  'debit card': 'bank',
  'credit card': 'credit_card',
  creditcard: 'credit_card',
  cc: 'credit_card',
  brokerage: 'investment',
  stocks: 'investment',
  mutual_fund: 'investment',
  mf: 'investment',
  bitcoin: 'crypto',
  btc: 'crypto',
  eth: 'crypto',
  ethereum: 'crypto',
  cash_on_hand: 'cash',
  petty_cash: 'cash',
  upi: 'wallet',
  paypal: 'wallet',
  digital_wallet: 'wallet',
  debt: 'loan',
  emi: 'loan',
  mortgage: 'loan',
};

function normalizeContainerType(
  raw: unknown,
): (typeof CONTAINER_TYPES)[number] {
  const key = String(raw || 'bank')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if ((CONTAINER_TYPES as readonly string[]).includes(key)) {
    return key as (typeof CONTAINER_TYPES)[number];
  }
  const spaced = key.replace(/_/g, ' ');
  return (
    CONTAINER_TYPE_ALIASES[key] ||
    CONTAINER_TYPE_ALIASES[spaced] ||
    'bank'
  );
}

/**
 * Drop undefined keys. Downstream update() implementations build SET clauses
 * from Object.keys (categories) or spread-merge over the stored row
 * (recurring), so an undefined key would wipe a stored value or trip NOT NULL.
 */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

type AmountOptions = {
  /** Accept 0 (default: strictly positive). */
  allowZero?: boolean;
  /** Accept negative values, e.g. an overdrawn opening balance. */
  allowNegative?: boolean;
  /** Decimal places to round to (default 2). */
  decimals?: number;
};

/**
 * Parse a model-supplied money / price / rate value. Strips whitespace,
 * thousands separators and currency symbols/codes; rejects anything that is
 * not a finite number in range so NaN never reaches the database.
 */
function parseAmount(
  value: unknown,
  field: string,
  options?: AmountOptions & { optional?: false },
): number;
function parseAmount(
  value: unknown,
  field: string,
  options: AmountOptions & { optional: true },
): number | undefined;
function parseAmount(
  value: unknown,
  field: string,
  options: AmountOptions & { optional?: boolean } = {},
): number | undefined {
  const blank =
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '');
  if (blank) {
    if (options.optional) return undefined;
    throw new BadRequestException(`${field} is required.`);
  }

  let parsed = Number.NaN;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    const cleaned = value
      .trim()
      .replace(/^(?:rs\.?|inr|usd|eur|gbp|aud|cad|sgd|aed)\s*/i, '')
      .replace(/\s*(?:inr|usd|eur|gbp|aud|cad|sgd|aed)$/i, '')
      .replace(/[\s,₹$€£¥]/g, '');
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) {
      parsed = Number(cleaned);
    }
  }

  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(
      `${field} must be a number (received "${String(value).slice(0, 40)}").`,
    );
  }
  if (parsed < 0 && !options.allowNegative) {
    throw new BadRequestException(`${field} cannot be negative.`);
  }
  if (parsed === 0 && !options.allowZero && !options.allowNegative) {
    throw new BadRequestException(`${field} must be greater than zero.`);
  }
  const factor = 10 ** (options.decimals ?? 2);
  return Math.round(parsed * factor) / factor;
}

export type ToolActivity = {
  name: string;
  status: 'ok' | 'error';
  summary: string;
};

export type Citation = {
  label: string;
  href: string;
  snippet?: string;
  domain?: string;
  image_url?: string;
  source_type?: 'module' | 'web';
};

@Injectable()
export class AiToolsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    private readonly reportsService: ReportsService,
    private readonly accountsService: AccountsService,
    private readonly transactionsService: TransactionsService,
    private readonly budgetsService: BudgetsService,
    private readonly goalsService: GoalsService,
    private readonly investmentsService: InvestmentsService,
    private readonly categoriesService: CategoriesService,
    private readonly loansService: LoansService,
    private readonly recurringService: RecurringService,
    private readonly spacesService: SpacesService,
  ) {}

  async gatherContext(
    userId: string,
    options?: { deepTools?: string[] },
  ): Promise<{
    context: Record<string, unknown>;
    activity: ToolActivity[];
    citations: Citation[];
  }> {
    const deep = new Set(options?.deepTools || []);
    const activity: ToolActivity[] = [];
    const citations: Citation[] = [
      { label: 'Reports', href: '/reports', source_type: 'module' },
      { label: 'Accounts', href: '/accounts', source_type: 'module' },
      { label: 'Transactions', href: '/expenses', source_type: 'module' },
      { label: 'Budgets', href: '/budgets', source_type: 'module' },
      { label: 'Goals', href: '/goals', source_type: 'module' },
      { label: 'Investments', href: '/investments', source_type: 'module' },
      { label: 'Loans', href: '/loans', source_type: 'module' },
      { label: 'Recurring', href: '/recurring', source_type: 'module' },
      { label: 'Spaces', href: '/spaces', source_type: 'module' },
    ];

    const context: Record<string, unknown> = {};
    // Accounts and categories are needed for every write proposal (ids), so
    // they are always loaded generously; the prompt budget protects them.
    const accountLimit = deep.has('list_accounts') ? 80 : 60;
    const txLimit = deep.has('list_transactions') ? 60 : 30;
    const categoryLimit = deep.has('list_categories') ? 200 : 150;

    await this.safeLoad(activity, 'get_user_profile', async () => {
      const profile = await this.loadUserProfile(userId);
      context.user = profile;
      return `Today is ${profile.today} (${profile.timezone})`;
    });

    await this.safeLoad(
      activity,
      'get_financial_overview',
      async () => {
        context.overview = await this.reportsService.overview(userId, 6);
        return 'Loaded 6-month twin overview';
      },
    );

    await this.safeLoad(
      activity,
      'list_accounts',
      async () => {
        const accounts = await this.accountsService.findAll(userId);
        context.accounts = accounts.slice(0, accountLimit).map((a: any) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          institution: a.institution || undefined,
          currency: a.currency,
          balance: a.balance,
          // For liabilities the balance is the amount owed.
          liability: ['credit_card', 'loan', 'payable'].includes(a.type)
            ? true
            : undefined,
        }));
        return `${accounts.length} containers`;
      },
    );

    await this.safeLoad(
      activity,
      'list_transactions',
      async () => {
        const tx = await this.transactionsService.findAll(userId);
        const rows = Array.isArray(tx) ? tx : [];
        context.recent_transactions = rows.slice(0, txLimit).map((t: any) => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          amount_base: t.amount_base,
          currency: t.currency,
          description: t.description,
          merchant: t.merchant,
          date: t.date,
          category_id: t.category_id,
          category_name: t.category_name,
        }));
        return `${Math.min(rows.length, txLimit)} recent ledger rows`;
      },
    );

    await this.safeLoad(activity, 'list_budgets', async () => {
      context.budgets = await this.budgetsService.findAll(userId);
      return 'Budget envelopes loaded';
    });

    await this.safeLoad(activity, 'list_goals', async () => {
      context.goals = await this.goalsService.findAll(userId);
      return 'Goals loaded';
    });

    await this.safeLoad(activity, 'list_investments', async () => {
      context.investments = await this.investmentsService.findAll(userId);
      return 'Holdings loaded';
    });

    await this.safeLoad(activity, 'list_loans', async () => {
      const loans = await this.loansService.findAll(userId);
      context.loans = (Array.isArray(loans) ? loans : []).slice(0, 30).map(
        (l: any) => ({
          id: l.id,
          name: l.name,
          lender: l.lender,
          principal: l.principal,
          remaining_principal: l.outstanding_balance ?? l.principal,
          annual_interest_rate: l.annual_interest_rate,
          term_months: l.term_months,
          status: l.status,
          payment_day: l.payment_day,
          emi: l.monthly_payment,
          currency: l.currency,
          payoff_percent: l.payoff_percent,
        }),
      );
      return `${(context.loans as any[])?.length || 0} debt plans`;
    });

    await this.safeLoad(activity, 'list_recurring', async () => {
      const schedules = await this.recurringService.findAll(userId);
      context.recurring = (Array.isArray(schedules) ? schedules : [])
        .slice(0, 40)
        .map((s: any) => ({
          id: s.id,
          name: s.name,
          transaction_type: s.transaction_type,
          amount: s.amount,
          currency: s.currency,
          frequency: s.frequency,
          next_execution: s.next_execution,
          status: s.status,
          category_name: s.category_name,
          description: s.description,
        }));
      return `${(context.recurring as any[])?.length || 0} schedules`;
    });

    await this.safeLoad(activity, 'list_spaces', async () => {
      context.spaces = await this.spacesService.overviewForAi(userId);
      return `${(context.spaces as any[])?.length || 0} collaborative spaces`;
    });

    await this.safeLoad(activity, 'list_categories', async () => {
      const categories = await this.categoriesService.findAll(userId);
      const rows = Array.isArray(categories) ? categories : [];
      const names = new Map(rows.map((c: any) => [c.id, c.name]));
      context.categories = rows.slice(0, categoryLimit).map((c: any) => ({
        id: c.id,
        name: c.name,
        parent: c.parent_id ? names.get(c.parent_id) || undefined : undefined,
      }));
      return `${rows.length} categories loaded`;
    });

    if (deep.has('list_uncategorized')) {
      await this.safeLoad(activity, 'list_uncategorized', async () => {
        const all = await this.transactionsService.findAll(userId);
        const rows = Array.isArray(all) ? all : [];
        context.uncategorized_transactions = rows
          .filter((t: any) => !t.category_id && !t.category_name)
          .slice(0, 40)
          .map((t: any) => ({
            id: t.id,
            type: t.type,
            amount: t.amount,
            currency: t.currency,
            description: t.description,
            merchant: t.merchant,
            date: t.date,
          }));
        return `${(context.uncategorized_transactions as any[])?.length || 0} uncategorized`;
      });
    }

    await this.safeLoad(activity, 'get_cash_flow', async () => {
      const overview = (context.overview as any) || {};
      context.cash_flow = {
        this_month: overview.this_month || overview.cash_flow || null,
        monthly: overview.monthly || overview.cashflow_series || null,
        savings_rate:
          overview.savings_rate ?? overview.this_month?.savings_rate,
      };
      return 'Cash-flow snapshot attached';
    });

    if (deep.has('simulate_scenario')) {
      await this.safeLoad(activity, 'simulate_scenario', async () => {
        context.scenario = await this.simulateScenario(userId, {
          cut_percent: 20,
          extra_monthly_savings: 5000,
          months: 12,
        });
        return 'Baseline what-if scenario computed';
      });
    }

    context.fx_sample = {
      USD_to_INR: getRate('USD', 'INR'),
      INR_to_USD: getRate('INR', 'USD'),
      note: 'Static pivot rates used by Opal until live FX is configured',
    };

    if (deep.size) {
      context.invoked_tools = [...deep];
    }

    return { context, activity, citations };
  }

  async simulateScenario(
    userId: string,
    opts: {
      cut_percent?: number;
      extra_monthly_savings?: number;
      months?: number;
      category?: string;
    },
  ) {
    const cutPercent = Math.min(80, Math.max(0, Number(opts.cut_percent ?? 20)));
    const extra = Math.max(0, Number(opts.extra_monthly_savings ?? 0));
    const months = Math.min(60, Math.max(1, Number(opts.months ?? 12)));

    let monthlyExpense = 0;
    let monthlyIncome = 0;
    let currency = 'USD';

    try {
      const overview: any = await this.reportsService.overview(userId, 6);
      monthlyExpense = Number(
        overview?.this_month?.expense ||
          overview?.cash_flow?.expense ||
          overview?.totals?.expense ||
          0,
      );
      monthlyIncome = Number(
        overview?.this_month?.income ||
          overview?.cash_flow?.income ||
          overview?.totals?.income ||
          0,
      );
      currency =
        overview?.base_currency ||
        overview?.currency ||
        overview?.this_month?.currency ||
        'USD';
    } catch {
      /* leave zeros */
    }

    const cutAmount = (monthlyExpense * cutPercent) / 100;
    const monthlyDelta = cutAmount + extra;
    const baselineSavings = monthlyIncome - monthlyExpense;
    const projectedMonthlySavings = baselineSavings + monthlyDelta;

    return {
      assumptions: {
        cut_percent: cutPercent,
        category_filter: opts.category || null,
        extra_monthly_savings: extra,
        months,
        currency,
      },
      baseline: {
        monthly_income: monthlyIncome,
        monthly_expense: monthlyExpense,
        monthly_savings: baselineSavings,
      },
      projected: {
        monthly_expense_after_cut: Math.max(0, monthlyExpense - cutAmount),
        monthly_savings: projectedMonthlySavings,
        cumulative_extra_savings: monthlyDelta * months,
        runway_note:
          projectedMonthlySavings > 0
            ? `At this pace you add ~${Math.round(monthlyDelta * months)} ${currency} over ${months} months vs today.`
            : 'Projected savings are still negative — prioritize expense cuts or income first.',
      },
    };
  }

  /** Base currency, effective timezone and "today" for the user. */
  async loadUserProfile(userId: string): Promise<AiUserProfile> {
    let row: Record<string, any> = {};
    try {
      const result = await this.pgPool.query(
        `SELECT full_name, currency, timezone, locale
         FROM users WHERE id = $1`,
        [userId],
      );
      row = result.rows[0] || {};
    } catch {
      row = {};
    }
    const baseCurrency = String(row.currency || 'USD').toUpperCase();
    const timezone = effectiveTimeZone(row.timezone, baseCurrency);
    const now = zonedNow(timezone);
    return {
      first_name: String(row.full_name || '').trim().split(/\s+/)[0] || null,
      base_currency: baseCurrency,
      timezone,
      locale: row.locale || null,
      today: now.date,
      now_local: `${now.date} ${now.time}`,
      weekday: now.weekday,
      month_first_dates: prefersMonthFirst(baseCurrency),
    };
  }

  /** Real accounts / categories / currency / timezone for proposal checks. */
  async proposalContext(
    userId: string,
    userText?: string,
  ): Promise<ProposalContext> {
    const [profile, accounts, categories] = await Promise.all([
      this.loadUserProfile(userId),
      this.accountsService.findAll(userId).catch(() => []),
      this.categoriesService.findAll(userId).catch(() => []),
    ]);
    return {
      accounts: (accounts as any[]).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        institution: a.institution,
        currency: a.currency,
        balance: a.balance,
      })),
      categories: (categories as any[]).map((c) => ({
        id: c.id,
        name: c.name,
        parent_id: c.parent_id,
      })),
      baseCurrency: profile.base_currency,
      timeZone: profile.timezone,
      monthFirst: profile.month_first_dates,
      userText,
    };
  }

  /**
   * Re-validate right before execution (proposals may predate a fix, or the
   * user's accounts may have changed): resolves account names to ids,
   * enforces classification / category / date rules, and turns an unsafe
   * payload into a clear question instead of a bad ledger write.
   */
  private async prepareProposalPayload(
    userId: string,
    actionType: string,
    payload: Record<string, any>,
  ): Promise<Record<string, any>> {
    const needsReferences =
      TRANSACTION_ACTIONS.has(actionType) ||
      [
        'create_budget',
        'update_budget',
        'create_goal',
        'create_holding',
        'create_loan',
        'update_loan',
        'create_space_expense',
        'propose_settlement',
      ].includes(actionType);
    if (!needsReferences) return payload;
    const ctx = await this.proposalContext(userId);
    const outcome = TRANSACTION_ACTIONS.has(actionType)
      ? validateTransactionProposal(actionType, payload, ctx)
      : repairReferenceIds(actionType, payload, ctx);
    if (!outcome.ok) {
      throw new BadRequestException(
        String(outcome.clarification || 'This proposal needs more detail.')
          .replace(/\*\*/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
      );
    }
    return outcome.payload;
  }

  async executeProposal(
    userId: string,
    actionType: string,
    rawPayload: Record<string, any>,
  ) {
    const payload = await this.prepareProposalPayload(
      userId,
      actionType,
      rawPayload || {},
    );
    switch (actionType) {
      case 'create_budget':
        return this.budgetsService.create(
          userId,
          compact({
            name: payload.name,
            amount: parseAmount(payload.amount, 'amount'),
            period_type: payload.period_type || 'monthly',
            category_id: payload.category_id,
            currency: payload.currency,
            notes: payload.notes,
          }) as any,
        );
      case 'update_budget':
        if (!payload.id) throw new BadRequestException('Budget id required');
        return this.budgetsService.update(
          userId,
          payload.id,
          compact({
            name: payload.name,
            amount: parseAmount(payload.amount, 'amount', { optional: true }),
            period_type: payload.period_type,
            category_id: payload.category_id,
            currency: payload.currency,
            notes: payload.notes,
          }) as any,
        );
      case 'create_goal':
        return this.goalsService.create(
          userId,
          compact({
            name: payload.name,
            goal_type: payload.goal_type || 'other',
            target_amount: parseAmount(payload.target_amount, 'target_amount'),
            current_amount: parseAmount(
              payload.current_amount,
              'current_amount',
              { optional: true, allowZero: true },
            ),
            currency: payload.currency,
            target_date: payload.target_date,
            container_id: payload.container_id,
            notes: payload.notes,
          }) as any,
        );
      case 'contribute_goal':
        if (!payload.id) throw new BadRequestException('Goal id required');
        return this.goalsService.contribute(userId, payload.id, {
          amount: parseAmount(payload.amount, 'amount'),
        });
      case 'create_account':
        return this.accountsService.create(
          userId,
          compact({
            name: payload.name,
            type: normalizeContainerType(payload.type),
            balance:
              parseAmount(payload.balance, 'balance', {
                optional: true,
                allowZero: true,
                allowNegative: true,
              }) ?? 0,
            currency: payload.currency,
            institution: payload.institution,
            color: payload.color,
            notes: payload.notes,
            include_in_net_worth: payload.include_in_net_worth ?? true,
          }) as any,
        );
      case 'create_category':
        return this.categoriesService.create(
          userId,
          compact({
            name: String(payload.name || '').trim(),
            description: payload.description,
            color: payload.color,
            icon: payload.icon,
            parent_id: payload.parent_id,
            budget_amount: parseAmount(payload.budget_amount, 'budget_amount', {
              optional: true,
            }),
            budget_period: payload.budget_period,
          }) as any,
        );
      case 'update_category':
        if (!payload.id) throw new BadRequestException('Category id required');
        return this.categoriesService.update(
          userId,
          payload.id,
          compact({
            name: payload.name,
            description: payload.description,
            color: payload.color,
            icon: payload.icon,
            parent_id: payload.parent_id,
            budget_amount: parseAmount(payload.budget_amount, 'budget_amount', {
              optional: true,
            }),
            budget_period: payload.budget_period,
          }) as any,
        );
      case 'create_transaction': {
        if (
          (payload.type || 'expense') === 'expense' &&
          !payload.source_container_id
        ) {
          throw new BadRequestException(
            'Paying account (source_container_id) is required for expenses',
          );
        }
        if (payload.type === 'income' && !payload.destination_container_id) {
          throw new BadRequestException(
            'Deposit account (destination_container_id) is required for income',
          );
        }
        if (
          payload.type === 'transfer' &&
          (!payload.source_container_id || !payload.destination_container_id)
        ) {
          throw new BadRequestException(
            'Transfer requires both source and destination accounts',
          );
        }
        const description = (
          String(payload.description ?? '').trim() ||
          String(payload.merchant ?? '').trim() ||
          'Opal transaction'
        ).slice(0, 500);
        return this.transactionsService.create(
          userId,
          compact({
            type: payload.type || 'expense',
            amount: parseAmount(payload.amount, 'amount'),
            description,
            date:
              normalizeIsoDate(payload.date) ??
              todayInTimeZone((await this.loadUserProfile(userId)).timezone),
            category_id: payload.category_id,
            source_container_id: payload.source_container_id,
            destination_container_id: payload.destination_container_id,
            merchant: payload.merchant,
            currency: payload.currency,
            exchange_rate: parseAmount(payload.exchange_rate, 'exchange_rate', {
              optional: true,
              decimals: 8,
            }),
            notes: payload.notes,
          }) as any,
        );
      }
      case 'update_transaction':
        if (!payload.id) throw new BadRequestException('Transaction id required');
        return this.transactionsService.update(
          userId,
          payload.id,
          compact({
            type: payload.type,
            amount: parseAmount(payload.amount, 'amount', { optional: true }),
            description: payload.description,
            date: payload.date,
            category_id: payload.category_id,
            source_container_id: payload.source_container_id,
            destination_container_id: payload.destination_container_id,
            merchant: payload.merchant,
            currency: payload.currency,
            exchange_rate: parseAmount(payload.exchange_rate, 'exchange_rate', {
              optional: true,
              decimals: 8,
            }),
            notes: payload.notes,
          }) as any,
        );
      case 'create_holding': {
        const avgCost = parseAmount(payload.avg_cost, 'avg_cost', {
          allowZero: true,
          decimals: 8,
        });
        return this.investmentsService.create(
          userId,
          compact({
            name: payload.name,
            symbol: payload.symbol,
            asset_type: payload.asset_type || 'other',
            quantity: parseAmount(payload.quantity, 'quantity', { decimals: 8 }),
            avg_cost: avgCost,
            // Without a quoted price, value the holding at cost until prices sync.
            current_price:
              parseAmount(payload.current_price, 'current_price', {
                optional: true,
                allowZero: true,
                decimals: 8,
              }) ?? avgCost,
            currency: payload.currency,
            container_id: payload.container_id,
            notes: payload.notes,
          }) as any,
        );
      }
      case 'create_recurring':
        return this.recurringService.create(
          userId,
          compact({
            name: payload.name,
            transaction_type: payload.transaction_type || 'expense',
            amount: parseAmount(payload.amount, 'amount'),
            description: payload.description || payload.name,
            category_id: payload.category_id,
            source_container_id: payload.source_container_id,
            destination_container_id: payload.destination_container_id,
            currency: payload.currency,
            exchange_rate: parseAmount(payload.exchange_rate, 'exchange_rate', {
              optional: true,
              decimals: 8,
            }),
            frequency: payload.frequency || 'monthly',
            start_date: payload.start_date,
            end_date: payload.end_date,
            execution_mode: payload.execution_mode,
            notes: payload.notes,
          }) as any,
        );
      case 'update_recurring':
        if (!payload.id) throw new BadRequestException('Recurring id required');
        return this.recurringService.update(
          userId,
          payload.id,
          compact({
            name: payload.name,
            transaction_type: payload.transaction_type,
            amount: parseAmount(payload.amount, 'amount', { optional: true }),
            description: payload.description,
            category_id: payload.category_id,
            source_container_id: payload.source_container_id,
            destination_container_id: payload.destination_container_id,
            currency: payload.currency,
            exchange_rate: parseAmount(payload.exchange_rate, 'exchange_rate', {
              optional: true,
              decimals: 8,
            }),
            frequency: payload.frequency,
            start_date: payload.start_date,
            end_date: payload.end_date,
            status: payload.status,
            notes: payload.notes,
          }) as any,
        );
      case 'create_loan':
        return this.loansService.create(
          userId,
          compact({
            container_id: payload.container_id,
            name: payload.name,
            lender: payload.lender,
            principal: parseAmount(payload.principal, 'principal'),
            annual_interest_rate: parseAmount(
              payload.annual_interest_rate,
              'annual_interest_rate',
              { allowZero: true, decimals: 4 },
            ),
            interest_type: payload.interest_type,
            term_months: parseAmount(payload.term_months, 'term_months', {
              decimals: 0,
            }),
            start_date: payload.start_date,
            payment_day: payload.payment_day,
            notes: payload.notes,
          }) as any,
        );
      case 'update_loan':
        if (!payload.id) throw new BadRequestException('Loan id required');
        return this.loansService.update(
          userId,
          payload.id,
          compact({
            container_id: payload.container_id,
            name: payload.name,
            lender: payload.lender,
            principal: parseAmount(payload.principal, 'principal', {
              optional: true,
            }),
            annual_interest_rate: parseAmount(
              payload.annual_interest_rate,
              'annual_interest_rate',
              { optional: true, allowZero: true, decimals: 4 },
            ),
            interest_type: payload.interest_type,
            term_months: parseAmount(payload.term_months, 'term_months', {
              optional: true,
              decimals: 0,
            }),
            start_date: payload.start_date,
            payment_day: payload.payment_day,
            status: payload.status,
            notes: payload.notes,
          }) as any,
        );
      case 'create_space_expense': {
        if (!payload.space_id) {
          throw new BadRequestException('space_id is required');
        }
        return this.spacesService.createExpense(
          userId,
          payload.space_id,
          compact({
            title: payload.title,
            amount: parseAmount(payload.amount, 'amount'),
            payer_member_id: payload.payer_member_id,
            split_method: payload.split_method || 'equal',
            participants: payload.participants,
            category: payload.category,
            expense_date: payload.expense_date,
            notes: payload.notes,
            link_to_personal: payload.link_to_personal === true,
            personal_container_id: payload.personal_container_id,
          }) as any,
        );
      }
      case 'propose_settlement': {
        if (!payload.space_id) {
          throw new BadRequestException('space_id is required');
        }
        return this.spacesService.createSettlement(
          userId,
          payload.space_id,
          compact({
            from_member_id: payload.from_member_id,
            to_member_id: payload.to_member_id,
            amount: parseAmount(payload.amount, 'amount'),
            notes: payload.notes,
            scheduled_at: payload.scheduled_at,
            link_to_personal: payload.link_to_personal === true,
            personal_container_id: payload.personal_container_id,
          }) as any,
        );
      }
      default:
        throw new BadRequestException(`Unsupported action: ${actionType}`);
    }
  }

  describeTools() {
    return AI_AT_TOOLS.map((t) => t.tool);
  }

  commandCatalog() {
    return {
      at_tools: AI_AT_TOOLS,
      slash_commands: AI_SLASH_COMMANDS,
      action_types: SUPPORTED_ACTION_TYPES,
    };
  }

  convert(amount: number, from: string, to: string) {
    return convertAmount(amount, from, to);
  }

  private async safeLoad(
    activity: ToolActivity[],
    name: string,
    loader: () => Promise<string>,
    enabled = true,
  ) {
    if (!enabled) return;
    try {
      const summary = await loader();
      activity.push({ name, status: 'ok', summary });
    } catch (error: any) {
      activity.push({
        name,
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }
  }
}
