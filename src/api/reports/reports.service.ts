import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { convertAmount } from 'src/common/currency/currency.data';
import { addDaysIso, diffDaysInclusive } from './report-schedule';
import type { PeriodSnapshot } from './report-period.types';

const LIABILITY_TYPES = new Set([
  'credit_card',
  'loan',
  'payable',
]);

const CASH_TYPES = new Set(['cash', 'wallet', 'bank']);
const INVEST_TYPES = new Set(['investment', 'gold', 'crypto']);

@Injectable()
export class ReportsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async overview(userId: string, months = 6) {
    const client = await this.pgPool.connect();
    try {
      const windowMonths = Math.min(24, Math.max(1, Number(months) || 6));
      const baseCurrency = await this.getUserCurrency(client, userId);
      const twin = await this.netWorthSnapshot(client, userId, baseCurrency);
      const cashFlow = await this.monthlyCashFlow(
        client,
        userId,
        windowMonths,
      );
      const categories = await this.spendingByCategory(client, userId);
      const budgets = await this.budgetSnapshot(client, userId, baseCurrency);
      const investments = await this.investmentSnapshot(
        client,
        userId,
        baseCurrency,
      );
      const merchants = await this.topMerchants(client, userId);

      const thisMonth = cashFlow[cashFlow.length - 1] || {
        income: 0,
        expense: 0,
        net: 0,
      };
      const savingsRate =
        thisMonth.income > 0
          ? Math.round(
              (((thisMonth.income - thisMonth.expense) / thisMonth.income) *
                100 +
                Number.EPSILON) *
                10,
            ) / 10
          : 0;

      return {
        base_currency: baseCurrency,
        months: windowMonths,
        generated_at: new Date().toISOString(),
        twin,
        cash_flow: cashFlow,
        spending_by_category: categories,
        budgets,
        investments,
        top_merchants: merchants,
        this_month: {
          income: thisMonth.income,
          expense: thisMonth.expense,
          net: thisMonth.net,
          savings_rate: savingsRate,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to build report overview',
      );
    } finally {
      client.release();
    }
  }

  private async getUserCurrency(
    client: PoolClient,
    userId: string,
  ): Promise<string> {
    const result = await client.query(
      `SELECT currency FROM users WHERE id = $1`,
      [userId],
    );
    return (result.rows[0]?.currency || 'USD').toUpperCase();
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private async netWorthSnapshot(
    client: PoolClient,
    userId: string,
    baseCurrency: string,
  ) {
    const result = await client.query(
      `SELECT type, balance, currency, include_in_net_worth
       FROM financial_containers
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );

    let assets = 0;
    let liabilities = 0;
    let cash = 0;
    let investments = 0;
    let containerCount = 0;

    for (const row of result.rows) {
      containerCount += 1;
      if (row.include_in_net_worth === false) continue;
      const amount = convertAmount(
        Number(row.balance),
        String(row.currency || 'USD').toUpperCase(),
        baseCurrency,
      );
      if (LIABILITY_TYPES.has(row.type)) {
        liabilities += amount;
      } else {
        assets += amount;
        if (CASH_TYPES.has(row.type)) cash += amount;
        if (INVEST_TYPES.has(row.type)) investments += amount;
      }
    }

    return {
      container_count: containerCount,
      assets: this.round(assets),
      liabilities: this.round(liabilities),
      net_worth: this.round(assets - liabilities),
      cash: this.round(cash),
      investments: this.round(investments),
    };
  }

  private async monthlyCashFlow(
    client: PoolClient,
    userId: string,
    months: number,
  ) {
    const result = await client.query(
      `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
              COALESCE(SUM(CASE WHEN type = 'income' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS expense
       FROM ledger_transactions
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND type IN ('income', 'expense')
         AND date >= (date_trunc('month', CURRENT_DATE) - ($2::int - 1) * INTERVAL '1 month')
       GROUP BY 1
       ORDER BY 1 ASC`,
      [userId, months],
    );

    const map = new Map<string, { income: number; expense: number }>();
    for (const row of result.rows) {
      map.set(row.month, {
        income: Number(row.income),
        expense: Number(row.expense),
      });
    }

    const series: Array<{
      month: string;
      income: number;
      expense: number;
      net: number;
    }> = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const row = map.get(key) || { income: 0, expense: 0 };
      series.push({
        month: key,
        income: this.round(row.income),
        expense: this.round(row.expense),
        net: this.round(row.income - row.expense),
      });
    }
    return series;
  }

  private async spendingByCategory(client: PoolClient, userId: string) {
    const result = await client.query(
      `SELECT COALESCE(c.id::text, 'uncategorized') AS category_id,
              COALESCE(c.name, 'Uncategorized') AS category_name,
              c.color AS category_color,
              COALESCE(SUM(COALESCE(t.amount_base, t.amount)), 0) AS amount
       FROM ledger_transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.deleted_at IS NULL
         AND t.type = 'expense'
         AND t.date >= date_trunc('month', CURRENT_DATE)
         AND t.date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
       GROUP BY c.id, c.name, c.color
       ORDER BY amount DESC
       LIMIT 12`,
      [userId],
    );

    const total = result.rows.reduce(
      (s, r) => s + Number(r.amount),
      0,
    );

    return result.rows.map((row) => {
      const amount = this.round(Number(row.amount));
      return {
        category_id: row.category_id,
        category_name: row.category_name,
        category_color: row.category_color,
        amount,
        percent:
          total > 0
            ? Math.round(((amount / total) * 100 + Number.EPSILON) * 10) / 10
            : 0,
      };
    });
  }

  private async budgetSnapshot(
    client: PoolClient,
    userId: string,
    baseCurrency: string,
  ) {
    const result = await client.query(
      `SELECT b.id, b.name, b.amount, b.currency, b.period_type, b.category_id,
              c.name AS category_name
       FROM budgets b
       LEFT JOIN categories c ON c.id = b.category_id
       WHERE b.user_id = $1 AND b.deleted_at IS NULL
       ORDER BY b.name ASC`,
      [userId],
    );

    const rows: Array<{
      id: string;
      name: string;
      category_name: string | null;
      period_type: string;
      amount: number;
      spent: number;
      remaining: number;
      percent: number;
      status: string;
    }> = [];
    for (const b of result.rows) {
      const period = this.periodWindow(b.period_type);
      const params: unknown[] = [userId, period.start, period.end];
      let categoryFilter = '';
      if (b.category_id) {
        categoryFilter = 'AND category_id = $4';
        params.push(b.category_id);
      }
      const spentRes = await client.query(
        `SELECT COALESCE(SUM(COALESCE(amount_base, amount)), 0) AS spent
         FROM ledger_transactions
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND type = 'expense'
           AND date >= $2::date
           AND date <= $3::date
           ${categoryFilter}`,
        params,
      );
      const spentBase = Number(spentRes.rows[0]?.spent || 0);
      const currency = String(b.currency || baseCurrency).toUpperCase();
      const amount = convertAmount(
        Number(b.amount),
        currency,
        baseCurrency,
      );
      const spent = this.round(spentBase);
      const remaining = this.round(amount - spent);
      const percent =
        amount > 0
          ? Math.round(((spent / amount) * 100 + Number.EPSILON) * 10) / 10
          : 0;
      rows.push({
        id: b.id,
        name: b.name,
        category_name: b.category_name,
        period_type: b.period_type,
        amount: this.round(amount),
        spent: this.round(spent),
        remaining,
        percent,
        status:
          spent > amount ? 'over' : percent >= 80 ? 'warning' : 'on_track',
      });
    }

    const totalBudget = this.round(rows.reduce((s, r) => s + r.amount, 0));
    const totalSpent = this.round(rows.reduce((s, r) => s + r.spent, 0));
    return {
      items: rows,
      total_budget: totalBudget,
      total_spent: totalSpent,
      remaining: this.round(totalBudget - totalSpent),
      over_count: rows.filter((r) => r.status === 'over').length,
    };
  }

  private periodWindow(periodType: string, now = new Date()) {
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    if (periodType === 'weekly') {
      const day = now.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const start = new Date(y, m, d + mondayOffset);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return { start: this.isoDate(start), end: this.isoDate(end) };
    }
    if (periodType === 'yearly') {
      return { start: `${y}-01-01`, end: `${y}-12-31` };
    }
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    return { start: this.isoDate(start), end: this.isoDate(end) };
  }

  private isoDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private async investmentSnapshot(
    client: PoolClient,
    userId: string,
    baseCurrency: string,
  ) {
    const result = await client.query(
      `SELECT asset_type, quantity, avg_cost, current_price, currency
       FROM investment_holdings
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );

    let totalValue = 0;
    let totalCost = 0;
    const byType = new Map<string, number>();

    for (const row of result.rows) {
      const currency = String(row.currency || 'USD').toUpperCase();
      const market = Number(row.quantity) * Number(row.current_price);
      const cost = Number(row.quantity) * Number(row.avg_cost);
      const marketBase = convertAmount(market, currency, baseCurrency);
      const costBase = convertAmount(cost, currency, baseCurrency);
      totalValue += marketBase;
      totalCost += costBase;
      byType.set(
        row.asset_type,
        this.round((byType.get(row.asset_type) || 0) + marketBase),
      );
    }

    const totalGain = this.round(totalValue - totalCost);
    return {
      holding_count: result.rows.length,
      total_value: this.round(totalValue),
      total_cost: this.round(totalCost),
      total_gain: totalGain,
      gain_percent:
        totalCost > 0
          ? Math.round(((totalGain / totalCost) * 100 + Number.EPSILON) * 10) /
            10
          : 0,
      allocation: [...byType.entries()]
        .map(([asset_type, value]) => ({
          asset_type,
          value,
          percent:
            totalValue > 0
              ? Math.round(((value / totalValue) * 100 + Number.EPSILON) * 10) /
                10
              : 0,
        }))
        .sort((a, b) => b.value - a.value),
    };
  }

  private async topMerchants(client: PoolClient, userId: string) {
    const result = await client.query(
      `SELECT merchant,
              COALESCE(SUM(COALESCE(amount_base, amount)), 0) AS amount,
              COUNT(*)::int AS tx_count
       FROM ledger_transactions
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND type = 'expense'
         AND merchant IS NOT NULL
         AND merchant <> ''
         AND date >= date_trunc('month', CURRENT_DATE)
       GROUP BY merchant
       ORDER BY amount DESC
       LIMIT 8`,
      [userId],
    );
    return result.rows.map((row) => ({
      merchant: row.merchant,
      amount: this.round(Number(row.amount)),
      tx_count: Number(row.tx_count),
    }));
  }

  async periodReport(
    userId: string,
    start: string,
    end: string,
    periodLabel: string,
    frequency = 'weekly',
  ): Promise<PeriodSnapshot> {
    const client = await this.pgPool.connect();
    try {
      const userRes = await client.query(
        `SELECT id, full_name, email, currency, timezone
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      if (!userRes.rowCount) {
        throw new BadRequestException('User not found');
      }
      const user = userRes.rows[0];
      const baseCurrency = String(user.currency || 'USD').toUpperCase();
      const days = Math.max(1, diffDaysInclusive(start, end));
      const prevEnd = addDaysIso(start, -1);
      const prevStart = addDaysIso(prevEnd, -(days - 1));

      const [totals, prevTotals, twin, cashFlow, spend, income, merchants, budgets, accounts, goals, loans, investments, largest, transactions] =
        await Promise.all([
          this.periodTotals(client, userId, start, end),
          this.periodTotals(client, userId, prevStart, prevEnd),
          this.netWorthSnapshot(client, userId, baseCurrency),
          this.periodCashFlow(client, userId, start, end, days),
          this.periodByCategory(client, userId, start, end, 'expense'),
          this.periodByCategory(client, userId, start, end, 'income'),
          this.periodMerchants(client, userId, start, end),
          this.budgetSnapshot(client, userId, baseCurrency),
          this.periodAccounts(client, userId),
          this.periodGoals(client, userId, baseCurrency),
          this.periodLoans(client, userId, baseCurrency),
          this.investmentSnapshot(client, userId, baseCurrency),
          this.periodTransactions(client, userId, start, end, 25, 'expense'),
          this.periodTransactions(client, userId, start, end, 1000),
        ]);

      const savingsRate =
        totals.income > 0
          ? this.round(((totals.income - totals.expense) / totals.income) * 100)
          : 0;

      return {
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          currency: baseCurrency,
          timezone: user.timezone || 'UTC',
        },
        period: { start, end, label: periodLabel, frequency },
        previous: {
          start: prevStart,
          end: prevEnd,
          income: prevTotals.income,
          expense: prevTotals.expense,
          net: prevTotals.net,
        },
        totals: {
          ...totals,
          savings_rate: savingsRate,
          income_change_pct: this.changePct(totals.income, prevTotals.income),
          expense_change_pct: this.changePct(totals.expense, prevTotals.expense),
        },
        twin,
        cash_flow: cashFlow,
        spending_by_category: spend,
        income_by_category: income,
        top_merchants: merchants,
        budgets,
        accounts,
        goals,
        loans,
        investments,
        largest_expenses: largest,
        transactions,
      };
    } finally {
      client.release();
    }
  }

  private changePct(current: number, previous: number): number | null {
    if (previous === 0) return current === 0 ? 0 : null;
    return this.round(((current - previous) / Math.abs(previous)) * 100);
  }

  private async periodTotals(
    client: PoolClient,
    userId: string,
    start: string,
    end: string,
  ) {
    const result = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS expense,
         COALESCE(SUM(CASE WHEN type = 'transfer' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS transfers,
         COUNT(*) FILTER (WHERE type IN ('income', 'expense', 'transfer'))::int AS tx_count
       FROM ledger_transactions
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND date >= $2::date
         AND date <= $3::date`,
      [userId, start, end],
    );
    const row = result.rows[0] || {};
    const income = this.round(Number(row.income || 0));
    const expense = this.round(Number(row.expense || 0));
    return {
      income,
      expense,
      transfers: this.round(Number(row.transfers || 0)),
      net: this.round(income - expense),
      tx_count: Number(row.tx_count || 0),
    };
  }

  private async periodCashFlow(
    client: PoolClient,
    userId: string,
    start: string,
    end: string,
    days: number,
  ) {
    const groupWeekly = days > 45;
    const result = await client.query(
      groupWeekly
        ? `SELECT to_char(date_trunc('week', date), 'YYYY-MM-DD') AS bucket,
                  COALESCE(SUM(CASE WHEN type = 'income' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS income,
                  COALESCE(SUM(CASE WHEN type = 'expense' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS expense
           FROM ledger_transactions
           WHERE user_id = $1 AND deleted_at IS NULL
             AND type IN ('income', 'expense')
             AND date >= $2::date AND date <= $3::date
           GROUP BY 1 ORDER BY 1`
        : `SELECT to_char(date, 'YYYY-MM-DD') AS bucket,
                  COALESCE(SUM(CASE WHEN type = 'income' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS income,
                  COALESCE(SUM(CASE WHEN type = 'expense' THEN COALESCE(amount_base, amount) ELSE 0 END), 0) AS expense
           FROM ledger_transactions
           WHERE user_id = $1 AND deleted_at IS NULL
             AND type IN ('income', 'expense')
             AND date >= $2::date AND date <= $3::date
           GROUP BY 1 ORDER BY 1`,
      [userId, start, end],
    );
    return result.rows.map((row) => {
      const income = this.round(Number(row.income));
      const expense = this.round(Number(row.expense));
      return {
        bucket: row.bucket,
        income,
        expense,
        net: this.round(income - expense),
      };
    });
  }

  private async periodByCategory(
    client: PoolClient,
    userId: string,
    start: string,
    end: string,
    type: 'expense' | 'income',
  ) {
    const result = await client.query(
      `SELECT COALESCE(c.name, 'Uncategorized') AS category_name,
              c.color AS category_color,
              COALESCE(SUM(COALESCE(t.amount_base, t.amount)), 0) AS amount
       FROM ledger_transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.deleted_at IS NULL
         AND t.type = $2
         AND t.date >= $3::date
         AND t.date <= $4::date
       GROUP BY c.name, c.color
       ORDER BY amount DESC
       LIMIT 12`,
      [userId, type, start, end],
    );
    const total = result.rows.reduce((sum, row) => sum + Number(row.amount), 0);
    return result.rows.map((row) => {
      const amount = this.round(Number(row.amount));
      return {
        category_name: row.category_name,
        category_color: row.category_color || null,
        amount,
        percent:
          total > 0 ? this.round((amount / total) * 100) : 0,
      };
    });
  }

  private async periodMerchants(
    client: PoolClient,
    userId: string,
    start: string,
    end: string,
  ) {
    const result = await client.query(
      `SELECT merchant,
              COALESCE(SUM(COALESCE(amount_base, amount)), 0) AS amount,
              COUNT(*)::int AS tx_count
       FROM ledger_transactions
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND type = 'expense'
         AND merchant IS NOT NULL
         AND merchant <> ''
         AND date >= $2::date
         AND date <= $3::date
       GROUP BY merchant
       ORDER BY amount DESC
       LIMIT 10`,
      [userId, start, end],
    );
    return result.rows.map((row) => ({
      merchant: row.merchant,
      amount: this.round(Number(row.amount)),
      tx_count: Number(row.tx_count),
    }));
  }

  private async periodAccounts(client: PoolClient, userId: string) {
    const result = await client.query(
      `SELECT name, type, balance, currency, include_in_net_worth
       FROM financial_containers
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY name ASC`,
      [userId],
    );
    return result.rows.map((row) => ({
      name: row.name,
      type: row.type,
      balance: this.round(Number(row.balance)),
      currency: String(row.currency || 'USD').toUpperCase(),
      include_in_net_worth: row.include_in_net_worth !== false,
    }));
  }

  private async periodGoals(
    client: PoolClient,
    userId: string,
    baseCurrency: string,
  ) {
    const result = await client.query(
      `SELECT name, target_amount, current_amount, currency, target_date
       FROM goals
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY name ASC`,
      [userId],
    );
    return result.rows.map((row) => {
      const currency = String(row.currency || baseCurrency).toUpperCase();
      const target = convertAmount(Number(row.target_amount), currency, baseCurrency);
      const current = convertAmount(Number(row.current_amount), currency, baseCurrency);
      return {
        name: row.name,
        target: this.round(target),
        current: this.round(current),
        percent: target > 0 ? this.round((current / target) * 100) : 0,
        currency: baseCurrency,
        target_date: row.target_date
          ? String(row.target_date).slice(0, 10)
          : null,
      };
    });
  }

  private async periodLoans(
    client: PoolClient,
    userId: string,
    baseCurrency: string,
  ) {
    const result = await client.query(
      `SELECT l.name, l.lender, l.principal, l.annual_interest_rate, l.status,
              fc.balance, fc.currency
       FROM loans l
       JOIN financial_containers fc ON fc.id = l.container_id
       WHERE l.user_id = $1 AND l.deleted_at IS NULL
       ORDER BY l.name ASC`,
      [userId],
    );
    return result.rows.map((row) => {
      const currency = String(row.currency || baseCurrency).toUpperCase();
      return {
        name: row.name,
        lender: row.lender || null,
        principal: this.round(
          convertAmount(Number(row.principal), currency, baseCurrency),
        ),
        balance: this.round(
          convertAmount(Number(row.balance), currency, baseCurrency),
        ),
        rate: this.round(Number(row.annual_interest_rate || 0)),
        status: row.status,
        currency: baseCurrency,
      };
    });
  }

  private async periodTransactions(
    client: PoolClient,
    userId: string,
    start: string,
    end: string,
    limit: number,
    type?: 'expense' | 'income',
  ) {
    const typeFilter = type ? 'AND t.type = $4' : '';
    const limitIdx = type ? 5 : 4;
    const result = await client.query(
      `SELECT to_char(t.date, 'YYYY-MM-DD') AS date,
              t.type, t.description, t.merchant, c.name AS category_name,
              COALESCE(t.amount_base, t.amount) AS amount,
              t.currency
       FROM ledger_transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.deleted_at IS NULL
         AND t.date >= $2::date
         AND t.date <= $3::date
         ${typeFilter}
       ORDER BY COALESCE(t.amount_base, t.amount) DESC, t.date DESC
       LIMIT $${limitIdx}`,
      type ? [userId, start, end, type, limit] : [userId, start, end, limit],
    );
    return result.rows.map((row) => ({
      date: row.date,
      type: row.type,
      description: row.description,
      merchant: row.merchant || null,
      category_name: row.category_name || null,
      amount: this.round(Number(row.amount)),
      currency: String(row.currency || 'USD').toUpperCase(),
    }));
  }
}
