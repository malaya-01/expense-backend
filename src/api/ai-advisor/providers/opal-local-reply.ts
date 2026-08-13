/**
 * Always-available Opal Advisor fallback when free remote backends are down.
 * Speaks as Opal (not a generic chatbot) using twin context when present.
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

function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && messages[i].content?.trim()) {
      return messages[i].content.trim();
    }
  }
  return '';
}

function extractTwinSnippet(messages: ChatMessage[]): string {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const match = system.match(
    /(?:Financial Twin|twin context|CURRENT TWIN|Tool results)([\s\S]{0,1800})/i,
  );
  if (!match) return '';
  return match[1].replace(/\s+/g, ' ').trim().slice(0, 900);
}

function looksLikeProductQuestion(text: string): boolean {
  return /about (this |the )?(app|application|opal)|what (is|does) opal|use cases?|features?|how (do|can) i (use|start)|what can (you|opal|this)/i.test(
    text,
  );
}

/**
 * Build a calm, in-product reply when remote free models are unavailable.
 */
export function buildLocalOpalReply(messages: ChatMessage[]): string {
  const userText = latestUserText(messages);
  const twin = extractTwinSnippet(messages);

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
    `Free model routing is momentarily busy, so I’m answering from your in-app twin context instead of an outside model.`,
    ``,
  ];

  if (twin) {
    lines.push(
      `Here’s what I can see from your Financial Twin right now:`,
      twin,
      ``,
      `**Next steps in Opal**`,
      `- Tighten the question (e.g. “Am I over budget?” or “What’s my net worth?”)`,
      `- Or open [Reports](/reports) / [Budgets](/budgets) while free routing recovers`,
      `- For unlimited model replies, connect OpenRouter in [Settings](/settings)`,
    );
  } else {
    lines.push(
      `I don’t have fresh twin numbers in this turn yet.`,
      ``,
      `**Try one of these**`,
      `- Ask again in a moment (free routes often recover quickly)`,
      `- Say something like “summarize my spending” after opening [Transactions](/expenses)`,
      `- Or connect your own key in [Settings → AI](/settings) for uninterrupted chat`,
    );
  }

  lines.push(``, `You’re talking to Opal — not a third-party chatbot.`);
  return lines.join('\n');
}
