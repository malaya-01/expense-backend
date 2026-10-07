import { BANK_ALIASES } from './match-container';

/**
 * Map what the user / model called an account ("HDFC card", "cash",
 * "Paytm", "savings", "SBI 4521") onto one of the user's real containers.
 * Never guesses: close scores come back as `ambiguous` so the advisor asks.
 * Pure (no Nest / DB imports).
 */

export type AccountLike = {
  id: string;
  name: string;
  type?: string | null;
  institution?: string | null;
  currency?: string | null;
  balance?: number | string | null;
};

export type AccountResolution<T extends AccountLike = AccountLike> =
  | { status: 'matched'; account: T; score: number }
  | { status: 'ambiguous'; candidates: T[] }
  | { status: 'none' };

export const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'payable']);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/a\/c/g, 'account')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Account-type words in the reference, e.g. "HDFC card" → credit_card. */
export function typeHints(ref: string): Set<string> {
  const text = normalizeText(ref);
  const hints = new Set<string>();
  if (/\bdebit card\b/.test(text)) hints.add('bank');
  else if (/\b(credit card|creditcard|cc|card)\b/.test(text)) hints.add('credit_card');
  if (/\b(cash|in hand|pocket|petty)\b/.test(text)) hints.add('cash');
  if (/\b(wallet|paytm|phonepe|amazon pay|mobikwik|freecharge|paypal)\b/.test(text)) {
    hints.add('wallet');
  }
  if (/\b(savings?|salary|current|checking|bank|account|acct)\b/.test(text)) {
    hints.add('bank');
  }
  if (/\b(demat|brokerage|zerodha|groww|upstox|investments?|mutual funds?|sip|ppf|nps|stocks?|portfolio)\b/.test(text)) {
    hints.add('investment');
  }
  if (/\b(loan|emi|mortgage)\b/.test(text)) hints.add('loan');
  if (/\bgold\b/.test(text)) hints.add('gold');
  if (/\b(crypto|bitcoin|btc|eth)\b/.test(text)) hints.add('crypto');
  return hints;
}

const STOP_WORDS = new Set([
  'my',
  'the',
  'a',
  'an',
  'from',
  'to',
  'into',
  'in',
  'using',
  'via',
  'with',
  'by',
  'of',
  'account',
  'acct',
  'card',
  'credit',
  'debit',
  'bank',
  'wallet',
  'paid',
  'pay',
]);

function significantTokens(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function aliasGroupsIn(text: string): number[] {
  const hay = ` ${normalizeText(text)} `;
  const groups: number[] = [];
  BANK_ALIASES.forEach((group, index) => {
    if (group.aliases.some((alias) => hay.includes(` ${alias} `))) groups.push(index);
  });
  return groups;
}

export function scoreAccount(account: AccountLike, ref: string): number {
  const refNorm = normalizeText(ref);
  if (!refNorm) return 0;
  const name = normalizeText(account.name);
  const institution = normalizeText(account.institution);
  const hay = `${name} ${institution}`.trim();
  const tokens = significantTokens(ref);
  const hints = typeHints(ref);
  let score = 0;

  if (name === refNorm) score += 120;
  else if (refNorm.length >= 3 && name.includes(refNorm)) score += 70;
  else if (name.length >= 3 && refNorm.includes(name)) score += 60;

  const nameWords = name.split(' ');
  for (const token of tokens) {
    if (nameWords.includes(token)) score += 25;
    else if (institution.split(' ').includes(token)) score += 15;
    else if (token.length >= 4 && nameWords.some((w) => w.startsWith(token))) score += 10;
  }

  const refBanks = aliasGroupsIn(ref);
  if (refBanks.length) {
    const rowBanks = aliasGroupsIn(hay);
    if (refBanks.some((g) => rowBanks.includes(g))) score += 35;
    else if (rowBanks.length) score -= 30;
  }

  const digits = refNorm.match(/\b\d{4}\b/)?.[0];
  if (digits && hay.includes(digits)) score += 80;

  if (hints.size && account.type) {
    if (hints.has(account.type)) score += 30;
    else if (score < 120) score -= 35;
    // A bare type word ("cash", "wallet") with no name tokens.
    if (!tokens.length && hints.has(account.type)) score += 20;
  }
  return score;
}

/**
 * Resolve one reference. `candidates` (optional) narrows the pool, e.g. only
 * credit_card containers for a card bill.
 */
export function resolveAccountRef<T extends AccountLike>(
  accounts: T[],
  ref: string | null | undefined,
  options?: { excludeIds?: string[]; minScore?: number; margin?: number },
): AccountResolution<T> {
  const text = String(ref ?? '').trim();
  if (!text || !accounts.length) return { status: 'none' };
  const excluded = new Set(options?.excludeIds || []);
  const pool = accounts.filter((a) => !excluded.has(a.id));

  if (isUuid(text)) {
    const byId = pool.find((a) => a.id === text);
    return byId ? { status: 'matched', account: byId, score: 1000 } : { status: 'none' };
  }

  const ranked = pool
    .map((account) => ({ account, score: scoreAccount(account, text) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const minScore = options?.minScore ?? 35;
  if (!top || top.score < minScore) return { status: 'none' };

  const exact = normalizeText(top.account.name) === normalizeText(text);
  const margin = options?.margin ?? 15;
  const close = ranked.filter((r) => r.score >= minScore && r.score >= top.score - margin);
  if (!exact && close.length > 1) {
    return { status: 'ambiguous', candidates: close.map((r) => r.account) };
  }
  return { status: 'matched', account: top.account, score: top.score };
}

/** Accounts whose name (or bank + type) is mentioned in free text. */
export function accountsMentioned<T extends AccountLike>(
  accounts: T[],
  text: string,
): T[] {
  const hay = ` ${normalizeText(text)} `;
  if (!hay.trim()) return [];
  return accounts.filter((account) => {
    const name = normalizeText(account.name);
    if (name.length >= 3 && hay.includes(` ${name} `)) return true;
    const tokens = significantTokens(account.name).filter((t) => t.length >= 4);
    return tokens.length > 0 && tokens.every((t) => hay.includes(` ${t} `));
  });
}

export function describeAccount(account: AccountLike): string {
  const type = String(account.type || '').replace(/_/g, ' ');
  return type ? `${account.name} (${type})` : account.name;
}
