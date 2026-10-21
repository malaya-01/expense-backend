/**
 * Instant Opal Advisor fallback when free remote LLMs are unavailable.
 * Must never dump system-prompt rules as "twin context".
 */

import type { ChatMessage } from './types';

const PRODUCT_BLURB = `I'm **Opal Advisor** — the built-in CFO inside Opal, your Personal Financial Operating System.

Opal isn't a one-purpose expense log. It builds your **Digital Financial Twin** so you can see where money lives, how it moves, and what to do next.

**What you can do in Opal**
- **Accounts** — cash, banks, cards, wallets, and other containers
- **Transactions** — income, spending, and transfers between containers
- **Budgets & Goals** — envelopes, targets, and progress
- **Loans & Investments** — debts, holdings, and net worth
- **Recurring** — subscriptions and scheduled money moves
- **Reports** — cash flow, trends, and health signals
- **Spaces** — shared finances with family or roommates
- **Offline & sync** — keep working without signal, then catch up

Ask me about your twin anytime — for example spending this month, budget pressure, or whether you can afford something.`;

const MENU_FLOW = `I'm **Opal Advisor**. Here's how Opal's main menu maps to money flow in your twin:

\`\`\`mermaid
flowchart LR
  Accounts["Accounts / containers"] --> Txn["Transactions"]
  Txn --> Budgets["Budgets"]
  Txn --> Goals["Goals"]
  Txn --> Reports["Reports / cash flow"]
  Accounts --> Invest["Investments"]
  Accounts --> Loans["Loans"]
  Txn --> Recurring["Recurring"]
  Accounts --> Spaces["Spaces"]
\`\`\`

**How value moves**
1. **Accounts** — where value lives (cash, bank, card, wallet, investment, loan…).
2. **Transactions** — income, expense, or transfer moves value between containers.
3. **Budgets / Goals / Recurring** — plan and constrain those moves.
4. **Investments & Loans** — specialized containers + related activity.
5. **Reports** — roll-ups of the ledger (cash flow, trends, health).
6. **Spaces** — shared containers and expenses with others.

Open [Accounts](/accounts) to see containers, [Transactions](/expenses) for the ledger, or [Reports](/reports) for the big picture.`;

function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && messages[i].content?.trim()) {
      return messages[i].content.trim();
    }
  }
  return '';
}

function systemContent(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === 'system')?.content || '';
}

/** Parse live twin JSON injected by prepareChat — never scrape safety rules. */
function parseTwinContext(messages: ChatMessage[]): Record<string, unknown> | null {
  const system = systemContent(messages);
  const marker = 'Live Opal twin context (JSON):';
  const idx = system.indexOf(marker);
  if (idx < 0) return null;
  const raw = system.slice(idx + marker.length).trim();
  const jsonChunk = raw.split(/\n\nCurrent public web sources|\n\nNo live web sources/)[0]?.trim();
  if (!jsonChunk) return null;
  try {
    const parsed = JSON.parse(jsonChunk);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function looksLikeProductQuestion(text: string): boolean {
  return /about (this |the )?(app|application|opal)|what (is|does) opal|use cases?|features?|how (do|can) i (use|start)|what can (you|opal|this)/i.test(
    text,
  );
}

function looksLikeMenuOrFlowQuestion(text: string): boolean {
  return /data\s*flow|menu\s*items?|navigation|sitemap|screen\s*map|how (does|do) (the )?(app|opal|menu)|architecture|flowchart|flow chart|mermaid/i.test(
    text,
  );
}

function countList(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function money(value: unknown, currency?: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const code = String(currency || '').toUpperCase();
  try {
    return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', {
      style: code ? 'currency' : 'decimal',
      ...(code ? { currency: code } : {}),
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return code ? `${code} ${amount.toFixed(0)}` : amount.toFixed(0);
  }
}

function summarizeTwin(twin: Record<string, unknown>): string {
  const bits: string[] = [];
  const overview = twin.overview as Record<string, unknown> | undefined;
  const snapshot = (overview?.twin || overview) as Record<string, unknown> | undefined;
  const currency =
    (overview?.base_currency as string | undefined) ||
    ((twin.user as Record<string, unknown> | undefined)?.base_currency as
      | string
      | undefined);
  const thisMonth = overview?.this_month as Record<string, unknown> | undefined;

  if (snapshot && typeof snapshot === 'object') {
    if (snapshot.net_worth != null) {
      bits.push(`Net worth: **${money(snapshot.net_worth, currency)}**`);
    }
    const assets = snapshot.assets ?? snapshot.total_assets;
    const liabilities = snapshot.liabilities ?? snapshot.total_liabilities;
    if (assets != null || liabilities != null) {
      bits.push(
        `Assets / liabilities: ${money(assets, currency)} / ${money(liabilities, currency)}`,
      );
    }
  }

  if (thisMonth && typeof thisMonth === 'object') {
    bits.push(
      `This month — income ${money(thisMonth.income, currency)}, spending ${money(thisMonth.expense, currency)}, net ${money(thisMonth.net, currency)}`,
    );
  }

  const accounts = (twin.accounts ?? twin.containers) as Array<Record<string, unknown>> | undefined;
  const nAccounts = countList(accounts);
  if (nAccounts && Array.isArray(accounts)) {
    const top = [...accounts]
      .filter((account) => account?.balance != null)
      .sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)))
      .slice(0, 4)
      .map(
        (account) =>
          `${account.name || 'Account'} ${money(account.balance, account.currency || currency)}`,
      );
    bits.push(
      top.length
        ? `Accounts (${nAccounts}): ${top.join('; ')}`
        : `Accounts in twin: **${nAccounts}**`,
    );
  }

  // Server totals only: adding up the listed rows mixed currencies and
  // covered just the newest few transactions.
  const stats = twin.ledger_stats as Record<string, any> | undefined;
  if (stats?.last_90_days) {
    bits.push(
      `Last 90 days — income ${money(stats.last_90_days.income, currency)}, spending ${money(stats.last_90_days.expense, currency)}`,
    );
    const top = (stats.last_90_days.expense_by_category || []).slice(0, 3);
    if (top.length) {
      bits.push(
        `Top spending: ${top.map((row: any) => `${row.category} ${money(row.spent, currency)}`).join('; ')}`,
      );
    }
  }

  const match = twin.matching_transactions as Record<string, any> | undefined;
  if (match) {
    const label = match.search_terms?.length
      ? `“${match.search_terms.join(' ')}”`
      : 'your question';
    if (!match.match_count) {
      bits.push(`No transactions in your ledger match ${label}.`);
    } else {
      const latest = match.rows?.[0];
      bits.push(
        `${match.match_count} transaction${match.match_count === 1 ? '' : 's'} match ${label}` +
          `${match.expense_total ? ` — spent ${money(match.expense_total, currency)}` : ''}` +
          `${match.income_total ? `, received ${money(match.income_total, currency)}` : ''}` +
          `${latest ? ` (latest: ${latest.description || latest.merchant || 'transaction'} on ${latest.date}, ${money(latest.amount, latest.currency || currency)})` : ''}`,
      );
    }
  }

  const nBudgets = countList(twin.budgets);
  if (nBudgets) bits.push(`Budgets loaded: **${nBudgets}**`);

  const nGoals = countList(twin.goals);
  if (nGoals) bits.push(`Goals loaded: **${nGoals}**`);

  const nLoans = countList(twin.loans);
  if (nLoans) bits.push(`Loans loaded: **${nLoans}**`);

  const nInvest = countList(twin.investments ?? twin.holdings);
  if (nInvest) bits.push(`Investment rows loaded: **${nInvest}**`);

  if (!bits.length) {
    return 'Twin tools ran, but this turn has little numeric detail to quote safely.';
  }
  return bits.map((b) => `- ${b}`).join('\n');
}

/**
 * Build a calm, in-product reply when remote free models are unavailable.
 */
export function buildLocalOpalReply(messages: ChatMessage[]): string {
  const userText = latestUserText(messages);
  const twin = parseTwinContext(messages);

  if (looksLikeMenuOrFlowQuestion(userText)) {
    return MENU_FLOW;
  }

  if (looksLikeProductQuestion(userText) || !userText) {
    return `${PRODUCT_BLURB}

${
  twin
    ? `I can also see parts of your twin right now — ask a specific money question and I’ll ground the answer in your data.`
    : `Open Accounts or Transactions if you want me to reason from live balances next.`
}`;
  }

  const lines = [
    `I'm **Opal Advisor** — still here with you inside Opal.`,
    ``,
    `The free AI models are busy right now, so I couldn’t write full advice for this question. Here’s what your twin shows — please ask again in a minute.`,
    ``,
  ];

  if (twin) {
    lines.push(
      `**What your twin tools returned**`,
      summarizeTwin(twin),
      ``,
      `I won’t invent anything beyond these numbers. For faster, unlimited answers you can connect your own AI key in [Settings → AI](/settings).`,
      ``,
      `**Next steps**`,
      `- Ask something concrete: “Am I over budget?” or “What’s my net worth?”`,
      `- Or open [Reports](/reports) / [Budgets](/budgets)`,
    );
  } else {
    lines.push(
      `I couldn’t load your twin data for this turn.`,
      ``,
      `**Try**`,
      `- Ask again in a minute`,
      `- Or connect your own AI key in [Settings → AI](/settings)`,
    );
  }

  lines.push(``, `You’re talking to Opal — not a third-party chatbot.`);
  return lines.join('\n');
}
