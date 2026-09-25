import { resolvePublicAppOrigin } from 'src/utils/url/public-app-url';
import type { PeriodSnapshot } from './report-period.types';

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function changeLabel(value: number | null) {
  if (value == null) return 'n/a vs prior';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}% vs prior`;
}

function asset(path: string) {
  const origin = resolvePublicAppOrigin();
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${clean}`;
}

function barRow(label: string, amount: string, percent: number, color: string) {
  const width = Math.max(2, Math.min(100, percent || 0));
  return `<tr>
    <td style="padding:6px 8px 6px 0;font-size:13px;color:#171717;width:38%;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;width:42%;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ececec;border-radius:999px;">
        <tr>
          <td width="${width}%" bgcolor="${color}" style="height:10px;border-radius:999px;background:${color};font-size:0;line-height:0;">&nbsp;</td>
          <td width="${100 - width}%" style="height:10px;font-size:0;line-height:0;">&nbsp;</td>
        </tr>
      </table>
    </td>
    <td align="right" style="padding:6px 0 6px 8px;font-size:13px;font-weight:600;color:#171717;white-space:nowrap;">${escapeHtml(amount)}</td>
  </tr>`;
}

function kpiCell(label: string, value: string, hint: string) {
  return `<td width="50%" valign="top" style="padding:6px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;border-radius:12px;">
      <tr>
        <td style="padding:12px 14px;">
          <div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#6b6b6b;">${escapeHtml(label)}</div>
          <div style="font-size:18px;line-height:24px;font-weight:700;color:#171717;padding-top:4px;">${escapeHtml(value)}</div>
          <div style="font-size:12px;color:#6b6b6b;padding-top:4px;">${escapeHtml(hint)}</div>
        </td>
      </tr>
    </table>
  </td>`;
}

function insightsHtml(text: string) {
  const blocks = String(text || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) {
    return `<p style="margin:0;font-size:14px;line-height:22px;color:#4d4d4d;">Insights will appear here once there is enough activity in the period.</p>`;
  }
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((line) => escapeHtml(line.trim()));
      return `<p style="margin:0 0 12px;font-size:14px;line-height:22px;color:#171717;">${lines.join('<br/>')}</p>`;
    })
    .join('');
}

export function buildPeriodReportEmail(params: {
  snapshot: PeriodSnapshot;
  insights: string;
  includeExcel: boolean;
}) {
  const { snapshot, insights, includeExcel } = params;
  const currency = snapshot.user.currency;
  const name = snapshot.user.full_name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const origin = resolvePublicAppOrigin();
  const reportsUrl = `${origin}/reports`;
  const settingsUrl = `${origin}/settings?section=reports`;
  const logoLight = asset('/brand/themes/vercel-light.png?v=4');
  const maxSpend = Math.max(
    ...snapshot.spending_by_category.map((row) => row.amount),
    1,
  );
  const maxFlow = Math.max(
    ...snapshot.cash_flow.map((row) => Math.max(row.income, row.expense)),
    1,
  );

  const categoryRows = snapshot.spending_by_category.length
    ? snapshot.spending_by_category
        .map((row) =>
          barRow(
            `${row.category_name} (${row.percent.toFixed(0)}%)`,
            money(row.amount, currency),
            (row.amount / maxSpend) * 100,
            row.category_color || '#0072f5',
          ),
        )
        .join('')
    : `<tr><td colspan="3" style="padding:8px 0;font-size:13px;color:#6b6b6b;">No expenses in this period.</td></tr>`;

  const cashRows = snapshot.cash_flow.length
    ? snapshot.cash_flow
        .slice(-10)
        .map((row) =>
          barRow(
            row.bucket,
            money(row.expense, currency),
            (row.expense / maxFlow) * 100,
            '#f5a524',
          ),
        )
        .join('')
    : `<tr><td colspan="3" style="padding:8px 0;font-size:13px;color:#6b6b6b;">No cash-flow movement in this period.</td></tr>`;

  const merchantRows = snapshot.top_merchants
    .slice(0, 6)
    .map(
      (row) =>
        `<tr>
          <td style="padding:7px 0;border-bottom:1px solid #ececec;font-size:13px;color:#171717;">${escapeHtml(row.merchant)}</td>
          <td style="padding:7px 0;border-bottom:1px solid #ececec;font-size:12px;color:#6b6b6b;">${row.tx_count} tx</td>
          <td align="right" style="padding:7px 0;border-bottom:1px solid #ececec;font-size:13px;font-weight:600;">${escapeHtml(money(row.amount, currency))}</td>
        </tr>`,
    )
    .join('');

  const budgetRows = snapshot.budgets.items
    .slice(0, 6)
    .map(
      (row) =>
        `<tr>
          <td style="padding:7px 0;border-bottom:1px solid #ececec;font-size:13px;">${escapeHtml(row.name)}</td>
          <td style="padding:7px 0;border-bottom:1px solid #ececec;font-size:12px;color:${row.status === 'over' ? '#c2500a' : '#6b6b6b'};">${row.percent.toFixed(0)}% used</td>
          <td align="right" style="padding:7px 0;border-bottom:1px solid #ececec;font-size:13px;font-weight:600;">${escapeHtml(money(row.spent, currency))}</td>
        </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Opal ${escapeHtml(snapshot.period.frequency)} report</title>
  <style>
    :root { color-scheme: light dark; }
    @media (prefers-color-scheme: dark) {
      .email-bg { background:#0c0d12 !important; }
      .email-card { background:#161821 !important; border-color:#1e2030 !important; }
      .email-heading, .email-text { color:#f3f4f8 !important; }
      .email-muted { color:#b0b4c4 !important; }
      .kpi { background:#0c0d12 !important; }
    }
  </style>
</head>
<body class="email-bg" style="margin:0;padding:0;background:#fafafa;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" class="email-bg" width="100%" cellspacing="0" cellpadding="0" style="background:#fafafa;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" class="email-card" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ececec;">
          <tr>
            <td style="padding:22px 28px;border-bottom:1px solid #ececec;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td><img src="${escapeHtml(logoLight)}" alt="Opal" width="36" height="36" style="display:block;border-radius:9px;border:0;" /></td>
                  <td style="padding-left:10px;">
                    <div style="font-size:15px;font-weight:700;color:#171717;">Opal</div>
                    <div style="font-size:12px;color:#6b6b6b;">${escapeHtml(snapshot.period.frequency)} financial report</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 28px 8px;">
              <h1 class="email-heading" style="margin:0 0 8px;font-size:22px;line-height:28px;font-weight:700;color:#171717;">Your money, ${escapeHtml(snapshot.period.label)}</h1>
              <p class="email-muted" style="margin:0 0 18px;font-size:14px;line-height:22px;color:#4d4d4d;">${escapeHtml(greeting)} Here is a full picture of cash flow, spending, budgets, and the twin — plus what to change next.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  ${kpiCell('Income', money(snapshot.totals.income, currency), changeLabel(snapshot.totals.income_change_pct))}
                  ${kpiCell('Expenses', money(snapshot.totals.expense, currency), changeLabel(snapshot.totals.expense_change_pct))}
                </tr>
                <tr>
                  ${kpiCell('Net', money(snapshot.totals.net, currency), `${snapshot.totals.savings_rate.toFixed(0)}% savings rate`)}
                  ${kpiCell('Net worth', money(snapshot.twin.net_worth, currency), `${snapshot.twin.container_count} containers`)}
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 18px;">
              <h2 style="margin:12px 0 8px;font-size:16px;color:#171717;">Spending mix</h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${categoryRows}</table>
              <h2 style="margin:20px 0 8px;font-size:16px;color:#171717;">Expense trend</h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${cashRows}</table>
              ${
                merchantRows
                  ? `<h2 style="margin:20px 0 8px;font-size:16px;color:#171717;">Top merchants</h2>
                     <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${merchantRows}</table>`
                  : ''
              }
              ${
                budgetRows
                  ? `<h2 style="margin:20px 0 8px;font-size:16px;color:#171717;">Budgets</h2>
                     <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${budgetRows}</table>`
                  : ''
              }
              <h2 style="margin:22px 0 8px;font-size:16px;color:#171717;">What to change</h2>
              ${insightsHtml(insights)}
              <p style="margin:16px 0 0;font-size:13px;color:#6b6b6b;">${
                includeExcel
                  ? 'A full Excel workbook is attached, with data-bar charts, transactions, accounts, goals, loans, and investments.'
                  : 'Open Reports in Opal for the interactive view.'
              }</p>
              <p style="margin:18px 0 0;">
                <a href="${escapeHtml(reportsUrl)}" style="display:inline-block;padding:11px 18px;background:#0072f5;color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600;">Open Reports</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 24px;border-top:1px solid #ececec;font-size:12px;line-height:18px;color:#6b6b6b;">
              Change cadence, dates, or turn this off in <a href="${escapeHtml(settingsUrl)}" style="color:#0072f5;">Settings → Reports</a>. This is decision support, not financial advice.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Opal ${snapshot.period.frequency} report`,
    snapshot.period.label,
    '',
    greeting,
    '',
    `Income: ${money(snapshot.totals.income, currency)} (${changeLabel(snapshot.totals.income_change_pct)})`,
    `Expenses: ${money(snapshot.totals.expense, currency)} (${changeLabel(snapshot.totals.expense_change_pct)})`,
    `Net: ${money(snapshot.totals.net, currency)}`,
    `Savings rate: ${snapshot.totals.savings_rate.toFixed(1)}%`,
    `Net worth: ${money(snapshot.twin.net_worth, currency)}`,
    '',
    'Spending by category:',
    ...snapshot.spending_by_category.map(
      (row) => `- ${row.category_name}: ${money(row.amount, currency)} (${row.percent.toFixed(1)}%)`,
    ),
    '',
    'What to change:',
    insights || 'Keep logging transactions so Opal can coach the next period.',
    '',
    includeExcel ? 'Excel workbook attached.' : '',
    `Reports: ${reportsUrl}`,
    `Schedule: ${settingsUrl}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { html, text };
}

export function heuristicInsights(snapshot: PeriodSnapshot): string {
  const currency = snapshot.user.currency;
  const lines: string[] = [];
  const top = snapshot.spending_by_category[0];
  if (top && snapshot.totals.expense > 0) {
    lines.push(
      `${top.category_name} is ${top.percent.toFixed(0)}% of spending (${money(top.amount, currency)}). Trim this category first if you want a faster savings lift.`,
    );
  }
  if ((snapshot.totals.expense_change_pct || 0) > 8) {
    lines.push(
      `Expenses rose ${snapshot.totals.expense_change_pct!.toFixed(1)}% versus the previous period. Review the largest merchants and one-off spikes before they become the new baseline.`,
    );
  } else if ((snapshot.totals.expense_change_pct || 0) < -8) {
    lines.push(
      `Spending fell ${Math.abs(snapshot.totals.expense_change_pct!).toFixed(1)}% versus the previous period. Lock the habits that created that gap so it does not rebound.`,
    );
  }
  if (snapshot.totals.income > 0 && snapshot.totals.savings_rate < 15) {
    lines.push(
      `Savings rate is ${snapshot.totals.savings_rate.toFixed(0)}%. Aim closer to 20% by moving a fixed amount to a goal or investment container on payday.`,
    );
  } else if (snapshot.totals.savings_rate >= 20) {
    lines.push(
      `Savings rate is ${snapshot.totals.savings_rate.toFixed(0)}%. Direct the surplus to an emergency fund or debt principal before lifestyle inflation absorbs it.`,
    );
  }
  const over = snapshot.budgets.items.filter((row) => row.status === 'over');
  if (over.length) {
    lines.push(
      `${over.length} budget${over.length === 1 ? '' : 's'} ran over, including ${over[0].name}. Recast the limit or cut that category for the rest of the month.`,
    );
  }
  if (snapshot.twin.liabilities > snapshot.twin.cash && snapshot.twin.liabilities > 0) {
    lines.push(
      'Liabilities now exceed cash. Keep a cash buffer of at least one month of expenses before extra investing.',
    );
  }
  const merchant = snapshot.top_merchants[0];
  if (merchant && snapshot.totals.expense > 0 && merchant.amount / snapshot.totals.expense > 0.18) {
    lines.push(
      `${merchant.merchant} is a concentrated outflow (${money(merchant.amount, currency)}). Check for subscriptions, duplicates, or a cheaper alternative.`,
    );
  }
  const laggingGoal = snapshot.goals
    .filter((row) => row.target > 0)
    .sort((a, b) => a.percent - b.percent)[0];
  if (laggingGoal && laggingGoal.percent < 50) {
    lines.push(
      `${laggingGoal.name} is ${laggingGoal.percent.toFixed(0)}% funded. A small automatic transfer each week will move this faster than waiting for leftover cash.`,
    );
  }
  if (!lines.length) {
    lines.push(
      'Activity in this period is light. Keep capturing every expense and income so the next report can show a clearer coaching plan.',
    );
  }
  return lines.slice(0, 7).join('\n\n');
}
