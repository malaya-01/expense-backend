import { Injectable } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { BudgetsService } from '../budgets/budgets.service';
import { GoalsService } from '../goals/goals.service';
import { InvestmentsService } from '../investments/investments.service';

/** Months of ledger history the dashboard needs (cash-flow chart "1Y" + margin). */
const DASHBOARD_MONTHS = 12;

@Injectable()
export class DashboardService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
    private readonly budgets: BudgetsService,
    private readonly goals: GoalsService,
    private readonly investments: InvestmentsService,
  ) {}

  /**
   * Everything the overview screen renders, in one response. The sections
   * run in parallel on separate pool connections, so the request costs one
   * auth check and roughly the slowest query instead of five full requests.
   */
  async overview(userId: string) {
    const now = new Date();
    const since = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - DASHBOARD_MONTHS, 1),
    )
      .toISOString()
      .slice(0, 10);

    const [accounts, transactions, budgets, goals, investments] =
      await Promise.allSettled([
        this.accounts.findAll(userId),
        this.transactions.findSince(userId, since),
        this.budgets.findAll(userId),
        this.goals.findAll(userId),
        this.investments.findAll(userId),
      ]);

    const value = <T>(result: PromiseSettledResult<T>): T | null =>
      result.status === 'fulfilled' ? result.value : null;
    const failed = (
      [
        ['accounts', accounts],
        ['transactions', transactions],
        ['budgets', budgets],
        ['goals', goals],
        ['investments', investments],
      ] as const
    )
      .filter(([, result]) => result.status === 'rejected')
      .map(([name]) => name);

    return {
      generated_at: now.toISOString(),
      transactions_since: since,
      accounts: value(accounts),
      transactions: value(transactions),
      budgets: value(budgets),
      goals: value(goals),
      investments: value(investments),
      failed,
    };
  }
}
