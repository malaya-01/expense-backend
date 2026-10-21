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

const LEDGER_ROW_SELECT = `SELECT t.id, t.date, t.type, t.amount, t.currency, t.amount_base,
         t.description, t.merchant, t.notes,
         c.name AS category_name,
         sc.name AS source_name,
         dc.name AS destination_name
  FROM ledger_transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN financial_containers sc ON sc.id = t.source_container_id
  LEFT JOIN financial_containers dc ON dc.id = t.destination_container_id`;

function roundMoney(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

/** One ledger row as the model sees it (ids kept for edit proposals). */
function compactLedgerRow(row: any) {
  const amount = Number(row.amount);
  const amountBase = row.amount_base == null ? null : Number(row.amount_base);
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    amount,
    currency: row.currency,
    // Only when it differs (foreign-currency row).
    amount_base:
      amountBase != null && Math.abs(amountBase - amount) > 0.005
        ? amountBase
        : undefined,
    description: row.description || undefined,
    merchant: row.merchant || undefined,
    category: row.category_name || undefined,
    from: row.source_name || undefined,
    to: row.destination_name || undefined,
    note: row.notes ? String(row.notes).slice(0, 120) : undefined,
  };
}

const SEARCH_STOPWORDS = new Set(
  `a about above after again all also am an and any are as at be been before being below between both but by can cannot could did do does doing done down during each few for from further get got had has have having he her here hers him his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours
  much many spend spent spending pay paid paying payment payments cost costs bought buy buying transaction transactions money amount total totals show list find give tell see check please opal advisor month months week weeks year years today yesterday last this next previous recent recently ago day days time times expense expenses income ledger account accounts rupees rs inr usd dollars want know help
  financial finance finances health healthy concrete action actions advice advise suggest suggestion suggestions plan planning improve improvement better best good bad worst risk risks risky overspend overspending overspent against budget budgets goal goals saving savings save invest investing investment investments afford affordable new should could would doing going need needs right currently overall summary summarize explain analyse analyze review status track progress compare next steps step fastest biggest`
    .split(/\s+/)
    .filter(Boolean),
);

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ALIASES: Record<string, number> = Object.fromEntries(
  MONTHS.flatMap((name, index) => [
    [name, index],
    [name.slice(0, 3), index],
  ]),
);

/** Words worth searching for (merchant, category, note) and plain amounts. */
export function searchTermsFrom(question: string): {
  terms: string[];
  amounts: number[];
} {
  const text = question.toLowerCase().replace(/^\/\w+\s*/, '').replace(/@\w+/g, ' ');
  const amounts = Array.from(
    new Set(
      (text.match(/(?:₹|rs\.?\s?|inr\s?|\$)?\b\d{2,7}(?:\.\d{1,2})?\b/g) || [])
        .map((raw) => Number(raw.replace(/[^\d.]/g, '')))
        .filter((n) => Number.isFinite(n) && n >= 10 && !(n >= 1990 && n <= 2100)),
    ),
  ).slice(0, 4);
  const terms = Array.from(
    new Set(
      (text.match(/[a-z][a-z0-9&'-]{2,}/g) || [])
        .map((word) => word.replace(/'s$/, ''))
        .filter(
          (word) =>
            word.length >= 3 &&
            !SEARCH_STOPWORDS.has(word) &&
            !(word in MONTH_ALIASES),
        ),
    ),
  ).slice(0, 6);
  return { terms, amounts };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "this month", "last month", "in September" → inclusive date range. */
export function dateRangeFrom(
  question: string,
  today?: string,
): { start: string; end: string } | null {
  const text = question.toLowerCase();
  const now = today ? new Date(`${today}T00:00:00Z`) : new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthRange = (year: number, month: number) => ({
    start: isoDay(new Date(Date.UTC(year, month, 1))),
    end: isoDay(new Date(Date.UTC(year, month + 1, 0))),
  });
  if (/\bthis month\b/.test(text)) return monthRange(y, m);
  if (/\b(last|previous) month\b/.test(text)) return monthRange(y, m - 1);
  if (/\bthis year\b/.test(text)) {
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (/\blast year\b/.test(text)) {
    return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
  }
  for (const [alias, month] of Object.entries(MONTH_ALIASES)) {
    const pattern = alias === 'may' ? /\bmay\s+(?:20\d\d|month)\b|\bin may\b/ : new RegExp(`\\b${alias}\\b`);
    if (!pattern.test(text)) continue;
    const yearMatch = text.match(/\b(20\d\d)\b/);
    // A named month without a year is the most recent one (not the future).
    const year = yearMatch ? Number(yearMatch[1]) : month > m ? y - 1 : y;
    return monthRange(year, month);
  }
  return null;
}

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
    options?: {
      deepTools?: string[];
      /** The user's question: drives the whole-ledger transaction search. */
      query?: string;
    },
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

    // The profile (today / timezone) scopes the question search below.
    await this.safeLoad(activity, 'get_user_profile', async () => {
      const profile = await this.loadUserProfile(userId);
      context.user = profile;
      return `Today is ${profile.today} (${profile.timezone})`;
    });
    const profile = context.user as AiUserProfile | undefined;

    // Independent loads run together (they used to run one after another,
    // ~12 round trips in series before the model was even called).
    await Promise.all([
      this.safeLoad(activity, 'get_financial_overview', async () => {
        context.overview = await this.reportsService.overview(userId, 6);
        return 'Loaded 6-month twin overview';
      }),

      this.safeLoad(activity, 'list_accounts', async () => {
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
      }),

      this.safeLoad(activity, 'list_transactions', async () => {
        const rows = await this.recentTransactions(userId, txLimit);
        context.recent_transactions = rows;
        return `${rows.length} recent ledger rows`;
      }),

      this.safeLoad(activity, 'ledger_stats', async () => {
        context.ledger_stats = await this.ledgerStats(userId);
        return 'Ledger totals computed';
      }),

      options?.query
        ? this.safeLoad(activity, 'search_transactions', async () => {
            const found = await this.searchTransactions(
              userId,
              options.query || '',
              profile?.today,
            );
            if (!found) return 'No search terms in the question';
            // A broad advice question with no hits is not a lookup; leave the
            // empty search out so the model does not report "nothing matched".
            const specific =
              Boolean(found.amounts || found.date_range) ||
              (found.search_terms?.length || 0) <= 2;
            if (!found.match_count && !specific) return 'No matching transactions';
            context.matching_transactions = found;
            return `${found.match_count} matching transactions`;
          })
        : Promise.resolve(),

      this.safeLoad(activity, 'list_budgets', async () => {
        const budgets = await this.budgetsService.findAll(userId);
        context.budgets = budgets.map((b: any) => ({
          id: b.id,
          name: b.name,
          category: b.category_name || undefined,
          period: b.period_type,
          currency: b.currency,
          amount: b.amount,
          spent: b.spent,
          remaining: b.remaining,
          percent: b.percent,
          status: b.status,
        }));
        return 'Budget envelopes loaded';
      }),

      this.safeLoad(activity, 'list_goals', async () => {
        const goals = await this.goalsService.findAll(userId);
        context.goals = goals.map((g: any) => ({
          id: g.id,
          name: g.name,
          currency: g.currency,
          target: g.target_amount,
          current: g.current_amount,
          remaining: g.remaining,
          percent: g.percent,
          status: g.status,
          target_date: g.target_date || undefined,
          predicted_date: g.predicted_date || undefined,
          container: g.container_name || undefined,
        }));
        return 'Goals loaded';
      }),

      this.safeLoad(activity, 'list_investments', async () => {
        const investments: any = await this.investmentsService.findAll(userId);
        context.investments = {
          summary: investments?.summary,
          holdings: (investments?.holdings || []).slice(0, 25).map((h: any) => ({
            id: h.id,
            name: h.name,
            symbol: h.symbol || undefined,
            type: h.asset_type,
            quantity: h.quantity,
            currency: h.currency,
            value: h.current_value ?? h.market_value,
            gain: h.gain ?? h.unrealized_gain,
            gain_percent: h.gain_percent,
            container: h.container_name || undefined,
          })),
        };
        return 'Holdings loaded';
      }),

      this.safeLoad(activity, 'list_loans', async () => {
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
      }),

      this.safeLoad(activity, 'list_recurring', async () => {
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
      }),

      this.safeLoad(activity, 'list_spaces', async () => {
        context.spaces = await this.spacesService.overviewForAi(userId);
        return `${(context.spaces as any[])?.length || 0} collaborative spaces`;
      }),

      this.safeLoad(activity, 'list_categories', async () => {
        const result = await this.pgPool.query(
          `SELECT id, name, parent_id FROM categories
           WHERE user_id = $1 AND deleted_at IS NULL
           ORDER BY name ASC`,
          [userId],
        );
        const rows = result.rows;
        const names = new Map(rows.map((c: any) => [c.id, c.name]));
        context.categories = rows.slice(0, categoryLimit).map((c: any) => ({
          id: c.id,
          name: c.name,
          parent: c.parent_id ? names.get(c.parent_id) || undefined : undefined,
        }));
        return `${rows.length} categories loaded`;
      }),

      deep.has('list_uncategorized')
        ? this.safeLoad(activity, 'list_uncategorized', async () => {
            const result = await this.pgPool.query(
              `SELECT id, type, amount, currency, description, merchant, date
               FROM ledger_transactions
               WHERE user_id = $1 AND deleted_at IS NULL AND category_id IS NULL
               ORDER BY date DESC, created_at DESC
               LIMIT 40`,
              [userId],
            );
            context.uncategorized_transactions = result.rows.map((t: any) => ({
              ...t,
              amount: Number(t.amount),
            }));
            return `${result.rows.length} uncategorized`;
          })
        : Promise.resolve(),
    ]);

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

  /** Newest ledger rows, compact (no full-ledger load just to keep 30). */
  private async recentTransactions(userId: string, limit: number) {
    const result = await this.pgPool.query(
      `${LEDGER_ROW_SELECT}
       WHERE t.user_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map(compactLedgerRow);
  }

  /**
   * Totals the model must quote instead of adding up (possibly trimmed)
   * lists itself — summing partial lists produced wrong numbers.
   */
  private async ledgerStats(userId: string) {
    const [totals, byCategory] = await Promise.all([
      this.pgPool.query(
        `SELECT COUNT(*)::int AS transaction_count,
                MIN(date) AS first_date,
                MAX(date) AS last_date,
                COALESCE(SUM(COALESCE(amount_base, amount))
                  FILTER (WHERE type = 'income' AND date >= CURRENT_DATE - 90), 0) AS income_90d,
                COALESCE(SUM(COALESCE(amount_base, amount))
                  FILTER (WHERE type = 'expense' AND date >= CURRENT_DATE - 90), 0) AS expense_90d
         FROM ledger_transactions
         WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      ),
      this.pgPool.query(
        `SELECT COALESCE(c.name, 'Uncategorized') AS category,
                SUM(COALESCE(t.amount_base, t.amount)) AS spent,
                COUNT(*)::int AS count
         FROM ledger_transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1 AND t.deleted_at IS NULL
           AND t.type = 'expense' AND t.date >= CURRENT_DATE - 90
         GROUP BY 1
         ORDER BY spent DESC
         LIMIT 12`,
        [userId],
      ),
    ]);
    const row = totals.rows[0] || {};
    return {
      note: 'Totals are in the base currency over the WHOLE ledger, not just the rows listed.',
      transaction_count: Number(row.transaction_count || 0),
      first_date: row.first_date || undefined,
      last_date: row.last_date || undefined,
      last_90_days: {
        income: roundMoney(row.income_90d),
        expense: roundMoney(row.expense_90d),
        expense_by_category: byCategory.rows.map((r: any) => ({
          category: r.category,
          spent: roundMoney(r.spent),
          count: r.count,
        })),
      },
    };
  }

  /**
   * Transactions that match the user's question (merchant, category, note,
   * amount, month), searched over the whole ledger with SQL totals. The
   * twin only carries the newest rows, so "when did I pay X" used to fail.
   */
  private async searchTransactions(
    userId: string,
    question: string,
    today?: string,
  ) {
    const { terms, amounts } = searchTermsFrom(question);
    const range = dateRangeFrom(question, today);
    if (!terms.length && !amounts.length && !range) return null;

    const params: unknown[] = [userId];
    const matchers: string[] = [];
    if (terms.length) {
      params.push(terms.map((term) => `%${term}%`));
      matchers.push(
        `lower(concat_ws(' ', t.description, t.merchant, t.notes, c.name, sc.name, dc.name)) LIKE ANY($${params.length}::text[])`,
      );
    }
    if (amounts.length) {
      params.push(amounts);
      matchers.push(`t.amount = ANY($${params.length}::numeric[])`);
    }
    let rangeSql = '';
    if (range) {
      params.push(range.start, range.end);
      rangeSql = `AND t.date >= $${params.length - 1}::date AND t.date <= $${params.length}::date`;
    }
    const where = `t.user_id = $1 AND t.deleted_at IS NULL ${rangeSql}
      ${matchers.length ? `AND (${matchers.join(' OR ')})` : ''}`;

    const [rows, totals] = await Promise.all([
      this.pgPool.query(
        `${LEDGER_ROW_SELECT}
         WHERE ${where}
         ORDER BY t.date DESC, t.created_at DESC
         LIMIT 25`,
        params,
      ),
      this.pgPool.query(
        `SELECT COUNT(*)::int AS match_count,
                MIN(t.date) AS first_date,
                MAX(t.date) AS last_date,
                COALESCE(SUM(COALESCE(t.amount_base, t.amount))
                  FILTER (WHERE t.type = 'expense'), 0) AS expense_total,
                COALESCE(SUM(COALESCE(t.amount_base, t.amount))
                  FILTER (WHERE t.type = 'income'), 0) AS income_total
         FROM ledger_transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN financial_containers sc ON sc.id = t.source_container_id
         LEFT JOIN financial_containers dc ON dc.id = t.destination_container_id
         WHERE ${where}`,
        params,
      ),
    ]);
    const summary = totals.rows[0] || {};
    return {
      note: 'Searched the whole ledger for this question. Totals cover ALL matches (base currency); rows show the newest 25.',
      search_terms: terms.length ? terms : undefined,
      amounts: amounts.length ? amounts : undefined,
      date_range: range || undefined,
      match_count: Number(summary.match_count || 0),
      first_date: summary.first_date || undefined,
      last_date: summary.last_date || undefined,
      expense_total: roundMoney(summary.expense_total),
      income_total: roundMoney(summary.income_total),
      rows: rows.rows.map(compactLedgerRow),
    };
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
