export type PeriodAccountRow = {
  name: string;
  type: string;
  balance: number;
  currency: string;
  include_in_net_worth: boolean;
};

export type PeriodGoalRow = {
  name: string;
  target: number;
  current: number;
  percent: number;
  currency: string;
  target_date: string | null;
};

export type PeriodLoanRow = {
  name: string;
  lender: string | null;
  principal: number;
  balance: number;
  rate: number;
  status: string;
  currency: string;
};

export type PeriodTxRow = {
  date: string;
  type: string;
  description: string;
  merchant: string | null;
  category_name: string | null;
  amount: number;
  currency: string;
};

export type PeriodSnapshot = {
  user: {
    id: string;
    full_name: string | null;
    email: string;
    currency: string;
    timezone: string;
  };
  period: {
    start: string;
    end: string;
    label: string;
    frequency: string;
  };
  previous: {
    start: string;
    end: string;
    income: number;
    expense: number;
    net: number;
  };
  totals: {
    income: number;
    expense: number;
    transfers: number;
    net: number;
    savings_rate: number;
    tx_count: number;
    income_change_pct: number | null;
    expense_change_pct: number | null;
  };
  twin: {
    container_count: number;
    assets: number;
    liabilities: number;
    net_worth: number;
    cash: number;
    investments: number;
  };
  cash_flow: Array<{
    bucket: string;
    income: number;
    expense: number;
    net: number;
  }>;
  spending_by_category: Array<{
    category_name: string;
    category_color: string | null;
    amount: number;
    percent: number;
  }>;
  income_by_category: Array<{
    category_name: string;
    amount: number;
    percent: number;
  }>;
  top_merchants: Array<{
    merchant: string;
    amount: number;
    tx_count: number;
  }>;
  budgets: {
    items: Array<{
      name: string;
      category_name: string | null;
      amount: number;
      spent: number;
      remaining: number;
      percent: number;
      status: string;
    }>;
    over_count: number;
  };
  accounts: PeriodAccountRow[];
  goals: PeriodGoalRow[];
  loans: PeriodLoanRow[];
  investments: {
    holding_count: number;
    total_value: number;
    total_cost: number;
    total_gain: number;
    gain_percent: number;
    allocation: Array<{ asset_type: string; value: number; percent: number }>;
  };
  largest_expenses: PeriodTxRow[];
  transactions: PeriodTxRow[];
};
