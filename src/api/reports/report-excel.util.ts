import * as ExcelJS from 'exceljs';
import type { PeriodSnapshot } from './report-period.types';

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(Number(n) || 0);
  } catch {
    return `${currency} ${(Number(n) || 0).toFixed(2)}`;
  }
}

function pct(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function styleHeader(row: ExcelJS.Row, fill: string) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: fill },
  };
  row.alignment = { vertical: 'middle' };
  row.height = 22;
}

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Array<Array<string | number | null>>,
  barsCol?: number,
) {
  const sheet = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.addRow(headers);
  styleHeader(sheet.getRow(1), 'FF171717');
  for (const row of rows) sheet.addRow(row);
  headers.forEach((_, idx) => {
    sheet.getColumn(idx + 1).width = idx === 0 ? 28 : 16;
  });
  if (barsCol && rows.length) {
    const col = sheet.getColumn(barsCol);
    col.width = 22;
    sheet.addConditionalFormatting({
      ref: `${col.letter}2:${col.letter}${rows.length + 1}`,
      rules: [
        {
          type: 'dataBar',
          cfvo: [{ type: 'min' }, { type: 'max' }],
          color: { argb: 'FF0072F5' },
          gradient: true,
          showValue: true,
        } as any,
      ],
    });
  }
  return sheet;
}

export async function buildPeriodWorkbook(snapshot: PeriodSnapshot): Promise<Buffer> {
  const currency = snapshot.user.currency;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Opal';
  wb.created = new Date();
  wb.title = `Opal financial report ${snapshot.period.label}`;

  const summary = wb.addWorksheet('Summary', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  summary.getColumn(1).width = 32;
  summary.getColumn(2).width = 28;
  summary.getColumn(3).width = 22;
  summary.addRow(['Opal financial report']);
  summary.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF171717' } };
  summary.addRow(['Period', snapshot.period.label]);
  summary.addRow(['Cadence', snapshot.period.frequency]);
  summary.addRow(['Currency', currency]);
  summary.addRow(['Generated', new Date().toISOString()]);
  summary.addRow([]);
  const kpiHeader = summary.addRow(['Metric', 'This period', 'Previous period']);
  styleHeader(kpiHeader, 'FF0072F5');
  summary.addRow(['Income', snapshot.totals.income, snapshot.previous.income]);
  summary.addRow(['Expenses', snapshot.totals.expense, snapshot.previous.expense]);
  summary.addRow(['Net', snapshot.totals.net, snapshot.previous.net]);
  summary.addRow(['Savings rate', `${snapshot.totals.savings_rate.toFixed(1)}%`, '']);
  summary.addRow(['Income change', pct(snapshot.totals.income_change_pct), '']);
  summary.addRow(['Expense change', pct(snapshot.totals.expense_change_pct), '']);
  summary.addRow(['Transactions', snapshot.totals.tx_count, '']);
  summary.addRow([]);
  const twinHeader = summary.addRow(['Financial twin', 'Amount', '']);
  styleHeader(twinHeader, 'FF171717');
  summary.addRow(['Net worth', snapshot.twin.net_worth]);
  summary.addRow(['Cash', snapshot.twin.cash]);
  summary.addRow(['Investments', snapshot.twin.investments]);
  summary.addRow(['Assets', snapshot.twin.assets]);
  summary.addRow(['Liabilities', snapshot.twin.liabilities]);
  summary.addRow(['Containers', snapshot.twin.container_count]);
  for (const col of [2, 3]) {
    summary.getColumn(col).numFmt = '#,##0.00';
  }

  addSheet(
    wb,
    'Cash flow',
    ['Bucket', 'Income', 'Expense', 'Net'],
    snapshot.cash_flow.map((row) => [row.bucket, row.income, row.expense, row.net]),
    3,
  );
  addSheet(
    wb,
    'Spending by category',
    ['Category', 'Amount', 'Share %'],
    snapshot.spending_by_category.map((row) => [
      row.category_name,
      row.amount,
      row.percent,
    ]),
    2,
  );
  addSheet(
    wb,
    'Income by category',
    ['Category', 'Amount', 'Share %'],
    snapshot.income_by_category.map((row) => [
      row.category_name,
      row.amount,
      row.percent,
    ]),
    2,
  );
  addSheet(
    wb,
    'Merchants',
    ['Merchant', 'Amount', 'Transactions'],
    snapshot.top_merchants.map((row) => [row.merchant, row.amount, row.tx_count]),
    2,
  );
  addSheet(
    wb,
    'Budgets',
    ['Budget', 'Category', 'Limit', 'Spent', 'Remaining', '% used', 'Status'],
    snapshot.budgets.items.map((row) => [
      row.name,
      row.category_name,
      row.amount,
      row.spent,
      row.remaining,
      row.percent,
      row.status,
    ]),
    4,
  );
  addSheet(
    wb,
    'Accounts',
    ['Account', 'Type', 'Balance', 'Currency', 'In net worth'],
    snapshot.accounts.map((row) => [
      row.name,
      row.type,
      row.balance,
      row.currency,
      row.include_in_net_worth ? 'Yes' : 'No',
    ]),
    3,
  );
  addSheet(
    wb,
    'Goals',
    ['Goal', 'Current', 'Target', 'Progress %', 'Target date'],
    snapshot.goals.map((row) => [
      row.name,
      row.current,
      row.target,
      row.percent,
      row.target_date,
    ]),
    2,
  );
  addSheet(
    wb,
    'Loans',
    ['Loan', 'Lender', 'Principal', 'Balance', 'Rate %', 'Status'],
    snapshot.loans.map((row) => [
      row.name,
      row.lender,
      row.principal,
      row.balance,
      row.rate,
      row.status,
    ]),
    4,
  );
  addSheet(
    wb,
    'Investments',
    ['Asset type', 'Value', 'Share %'],
    snapshot.investments.allocation.map((row) => [
      row.asset_type,
      row.value,
      row.percent,
    ]),
    2,
  );
  addSheet(
    wb,
    'Transactions',
    ['Date', 'Type', 'Description', 'Merchant', 'Category', 'Amount', 'Currency'],
    snapshot.transactions.map((row) => [
      row.date,
      row.type,
      row.description,
      row.merchant,
      row.category_name,
      row.amount,
      row.currency,
    ]),
    6,
  );

  const notes = wb.addWorksheet('How to chart');
  notes.getColumn(1).width = 90;
  notes.addRow(['Charts in this workbook']);
  notes.getRow(1).font = { bold: true, size: 14 };
  notes.addRow([
    'Spending, cash flow, merchants, budgets, and transactions already include Excel data bars. To add a column or pie chart: select the numeric columns on Cash flow or Spending by category, then Insert → Chart.',
  ]);
  notes.addRow([
    `Figures are in ${currency}. Amounts on the twin sheets use your reporting currency.`,
  ]);
  notes.addRow([
    `This period ${money(snapshot.totals.income, currency)} in, ${money(snapshot.totals.expense, currency)} out, net ${money(snapshot.totals.net, currency)}.`,
  ]);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
