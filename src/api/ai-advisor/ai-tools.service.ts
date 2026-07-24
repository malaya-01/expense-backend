import { BadRequestException, Injectable } from '@nestjs/common';
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
    const accountLimit = deep.has('list_accounts') ? 50 : 30;
    const txLimit = deep.has('list_transactions') ? 60 : 30;
    const categoryLimit = deep.has('list_categories') ? 120 : 40;

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
          balance: a.balance,
          currency: a.currency,
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
      context.categories = (Array.isArray(categories) ? categories : [])
        .slice(0, categoryLimit)
        .map((c: any) => ({ id: c.id, name: c.name }));
      return 'Categories loaded';
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
      note: 'Static pivot rates used by FinOS until live FX is configured',
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

  async executeProposal(
    userId: string,
    actionType: string,
    payload: Record<string, any>,
  ) {
    switch (actionType) {
      case 'create_budget':
        return this.budgetsService.create(userId, {
          name: payload.name,
          amount: Number(payload.amount),
          period_type: payload.period_type || 'monthly',
          category_id: payload.category_id,
          currency: payload.currency,
          notes: payload.notes,
        } as any);
      case 'update_budget':
        if (!payload.id) throw new BadRequestException('Budget id required');
        return this.budgetsService.update(userId, payload.id, {
          name: payload.name,
          amount:
            payload.amount !== undefined ? Number(payload.amount) : undefined,
          period_type: payload.period_type,
          category_id: payload.category_id,
          currency: payload.currency,
          notes: payload.notes,
        } as any);
      case 'create_goal':
        return this.goalsService.create(userId, {
          name: payload.name,
          goal_type: payload.goal_type || 'other',
          target_amount: Number(payload.target_amount),
          current_amount: payload.current_amount,
          currency: payload.currency,
          target_date: payload.target_date,
          container_id: payload.container_id,
          notes: payload.notes,
        } as any);
      case 'contribute_goal':
        if (!payload.id) throw new BadRequestException('Goal id required');
        return this.goalsService.contribute(userId, payload.id, {
          amount: Number(payload.amount),
        });
      case 'create_account':
        return this.accountsService.create(userId, {
          name: payload.name,
          type: normalizeContainerType(payload.type),
          balance: Number(payload.balance || 0),
          currency: payload.currency,
          institution: payload.institution,
          color: payload.color,
          notes: payload.notes,
          include_in_net_worth: payload.include_in_net_worth ?? true,
        } as any);
      case 'create_category':
        return this.categoriesService.create(userId, {
          name: String(payload.name || '').trim(),
          description: payload.description,
          color: payload.color,
          icon: payload.icon,
          parent_id: payload.parent_id,
          budget_amount: payload.budget_amount,
          budget_period: payload.budget_period,
        } as any);
      case 'update_category':
        if (!payload.id) throw new BadRequestException('Category id required');
        return this.categoriesService.update(userId, payload.id, {
          name: payload.name,
          description: payload.description,
          color: payload.color,
          icon: payload.icon,
          parent_id: payload.parent_id,
          budget_amount: payload.budget_amount,
          budget_period: payload.budget_period,
        } as any);
      case 'create_transaction':
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
        return this.transactionsService.create(userId, {
          type: payload.type || 'expense',
          amount: Number(payload.amount),
          description: payload.description,
          date: payload.date,
          category_id: payload.category_id,
          source_container_id: payload.source_container_id,
          destination_container_id: payload.destination_container_id,
          merchant: payload.merchant,
          currency: payload.currency,
          exchange_rate: payload.exchange_rate,
          notes: payload.notes,
        } as any);
      case 'update_transaction':
        if (!payload.id) throw new BadRequestException('Transaction id required');
        return this.transactionsService.update(userId, payload.id, {
          type: payload.type,
          amount:
            payload.amount !== undefined ? Number(payload.amount) : undefined,
          description: payload.description,
          date: payload.date,
          category_id: payload.category_id,
          source_container_id: payload.source_container_id,
          destination_container_id: payload.destination_container_id,
          merchant: payload.merchant,
          currency: payload.currency,
          exchange_rate: payload.exchange_rate,
          notes: payload.notes,
        } as any);
      case 'create_holding':
        return this.investmentsService.create(userId, {
          name: payload.name,
          symbol: payload.symbol,
          asset_type: payload.asset_type || 'other',
          quantity: Number(payload.quantity),
          avg_cost: Number(payload.avg_cost),
          current_price: Number(payload.current_price),
          currency: payload.currency,
          container_id: payload.container_id,
          notes: payload.notes,
        } as any);
      case 'create_recurring':
        return this.recurringService.create(userId, {
          name: payload.name,
          transaction_type: payload.transaction_type || 'expense',
          amount: Number(payload.amount),
          description: payload.description || payload.name,
          category_id: payload.category_id,
          source_container_id: payload.source_container_id,
          destination_container_id: payload.destination_container_id,
          currency: payload.currency,
          exchange_rate: payload.exchange_rate,
          frequency: payload.frequency || 'monthly',
          start_date: payload.start_date,
          end_date: payload.end_date,
          execution_mode: payload.execution_mode,
          notes: payload.notes,
        } as any);
      case 'update_recurring':
        if (!payload.id) throw new BadRequestException('Recurring id required');
        return this.recurringService.update(userId, payload.id, {
          name: payload.name,
          transaction_type: payload.transaction_type,
          amount:
            payload.amount !== undefined ? Number(payload.amount) : undefined,
          description: payload.description,
          category_id: payload.category_id,
          source_container_id: payload.source_container_id,
          destination_container_id: payload.destination_container_id,
          currency: payload.currency,
          frequency: payload.frequency,
          start_date: payload.start_date,
          end_date: payload.end_date,
          status: payload.status,
          notes: payload.notes,
        } as any);
      case 'create_loan':
        return this.loansService.create(userId, {
          container_id: payload.container_id,
          name: payload.name,
          lender: payload.lender,
          principal: Number(payload.principal),
          annual_interest_rate: Number(payload.annual_interest_rate),
          interest_type: payload.interest_type,
          term_months: Number(payload.term_months),
          start_date: payload.start_date,
          payment_day: payload.payment_day,
          notes: payload.notes,
        } as any);
      case 'update_loan':
        if (!payload.id) throw new BadRequestException('Loan id required');
        return this.loansService.update(userId, payload.id, {
          container_id: payload.container_id,
          name: payload.name,
          lender: payload.lender,
          principal:
            payload.principal !== undefined
              ? Number(payload.principal)
              : undefined,
          annual_interest_rate:
            payload.annual_interest_rate !== undefined
              ? Number(payload.annual_interest_rate)
              : undefined,
          interest_type: payload.interest_type,
          term_months:
            payload.term_months !== undefined
              ? Number(payload.term_months)
              : undefined,
          start_date: payload.start_date,
          payment_day: payload.payment_day,
          status: payload.status,
          notes: payload.notes,
        } as any);
      case 'create_space_expense': {
        if (!payload.space_id) {
          throw new BadRequestException('space_id is required');
        }
        return this.spacesService.createExpense(userId, payload.space_id, {
          title: payload.title,
          amount: Number(payload.amount),
          payer_member_id: payload.payer_member_id,
          split_method: payload.split_method || 'equal',
          participants: payload.participants,
          category: payload.category,
          expense_date: payload.expense_date,
          notes: payload.notes,
          link_to_personal: payload.link_to_personal === true,
          personal_container_id: payload.personal_container_id,
        } as any);
      }
      case 'propose_settlement': {
        if (!payload.space_id) {
          throw new BadRequestException('space_id is required');
        }
        return this.spacesService.createSettlement(userId, payload.space_id, {
          from_member_id: payload.from_member_id,
          to_member_id: payload.to_member_id,
          amount: Number(payload.amount),
          notes: payload.notes,
          scheduled_at: payload.scheduled_at,
          link_to_personal: payload.link_to_personal === true,
          personal_container_id: payload.personal_container_id,
        } as any);
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
