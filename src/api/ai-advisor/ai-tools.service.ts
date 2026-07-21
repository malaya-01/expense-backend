import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { BudgetsService } from '../budgets/budgets.service';
import { CategoriesService } from '../categories/categories.service';
import { GoalsService } from '../goals/goals.service';
import { InvestmentsService } from '../investments/investments.service';
import { ReportsService } from '../reports/reports.service';
import { TransactionsService } from '../transactions/transactions.service';
import { convertAmount, getRate } from 'src/common/currency/currency.data';

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
  ) {}

  async gatherContext(userId: string): Promise<{
    context: Record<string, unknown>;
    activity: ToolActivity[];
    citations: Citation[];
  }> {
    const activity: ToolActivity[] = [];
    const citations: Citation[] = [
      { label: 'Reports', href: '/reports', source_type: 'module' },
      { label: 'Accounts', href: '/accounts', source_type: 'module' },
      { label: 'Transactions', href: '/expenses', source_type: 'module' },
      { label: 'Budgets', href: '/budgets', source_type: 'module' },
      { label: 'Goals', href: '/goals', source_type: 'module' },
      { label: 'Investments', href: '/investments', source_type: 'module' },
    ];

    const context: Record<string, unknown> = {};

    try {
      context.overview = await this.reportsService.overview(userId, 6);
      activity.push({
        name: 'get_financial_overview',
        status: 'ok',
        summary: 'Loaded 6-month twin overview',
      });
    } catch (error: any) {
      activity.push({
        name: 'get_financial_overview',
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }

    try {
      const accounts = await this.accountsService.findAll(userId);
      context.accounts = accounts.slice(0, 20).map((a: any) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        balance: a.balance,
        currency: a.currency,
      }));
      activity.push({
        name: 'list_accounts',
        status: 'ok',
        summary: `${accounts.length} containers`,
      });
    } catch (error: any) {
      activity.push({
        name: 'list_accounts',
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }

    try {
      const tx = await this.transactionsService.findAll(userId);
      const recent = (Array.isArray(tx) ? tx : [])
        .slice(0, 15)
        .map((t: any) => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          amount_base: t.amount_base,
          currency: t.currency,
          description: t.description,
          date: t.date,
          category_name: t.category_name,
        }));
      context.recent_transactions = recent;
      activity.push({
        name: 'list_transactions',
        status: 'ok',
        summary: `${recent.length} recent ledger rows`,
      });
    } catch (error: any) {
      activity.push({
        name: 'list_transactions',
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }

    try {
      context.budgets = await this.budgetsService.findAll(userId);
      activity.push({
        name: 'list_budgets',
        status: 'ok',
        summary: 'Budget envelopes loaded',
      });
    } catch (error: any) {
      activity.push({
        name: 'list_budgets',
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }

    try {
      context.goals = await this.goalsService.findAll(userId);
      activity.push({
        name: 'list_goals',
        status: 'ok',
        summary: 'Goals loaded',
      });
    } catch (error: any) {
      activity.push({
        name: 'list_goals',
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }

    try {
      context.investments = await this.investmentsService.findAll(userId);
      activity.push({
        name: 'list_investments',
        status: 'ok',
        summary: 'Holdings loaded',
      });
    } catch (error: any) {
      activity.push({
        name: 'list_investments',
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }

    try {
      const categories = await this.categoriesService.findAll(userId);
      context.categories = (Array.isArray(categories) ? categories : [])
        .slice(0, 30)
        .map((c: any) => ({ id: c.id, name: c.name }));
      activity.push({
        name: 'list_categories',
        status: 'ok',
        summary: 'Categories loaded',
      });
    } catch (error: any) {
      activity.push({
        name: 'list_categories',
        status: 'error',
        summary: error?.message || 'Failed',
      });
    }

    context.fx_sample = {
      USD_to_INR: getRate('USD', 'INR'),
      INR_to_USD: getRate('INR', 'USD'),
      note: 'Static pivot rates used by FinOS until live FX is configured',
    };

    return { context, activity, citations };
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
          type: payload.type || 'bank',
          balance: Number(payload.balance || 0),
          currency: payload.currency,
          institution: payload.institution,
          color: payload.color,
          notes: payload.notes,
          include_in_net_worth: payload.include_in_net_worth ?? true,
        } as any);
      case 'create_transaction':
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
      default:
        throw new BadRequestException(`Unsupported action: ${actionType}`);
    }
  }

  /** Keep for tools prompt documentation */
  describeTools() {
    return [
      'get_financial_overview',
      'list_accounts',
      'list_transactions',
      'list_budgets',
      'list_goals',
      'list_investments',
      'list_categories',
      'fx_convert (server-side rates)',
    ];
  }

  convert(amount: number, from: string, to: string) {
    return convertAmount(amount, from, to);
  }
}
