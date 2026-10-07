import { convertAmount } from '../../common/currency/currency.data';
import {
  AccountLike,
  LIABILITY_TYPES,
  accountsMentioned,
  describeAccount,
  isUuid,
  resolveAccountRef,
} from './account-resolver';
import {
  CategoryLike,
  fallbackCategory,
  findCategoryByName,
  suggestCategoryFromText,
} from './category-matcher';
import {
  diffDaysIso,
  findDateExpressions,
  isPlausibleDate,
  normalizeIsoDate,
  resolveDatePhrase,
  todayInTimeZone,
} from './user-dates';

/**
 * Validates and repairs model-authored transaction proposals against the
 * user's REAL accounts and categories before they reach a Confirm card, and
 * again right before execution. Classification (expense / income / transfer),
 * account resolution, categorisation, description, currency and date rules
 * all live here so prompt drift cannot produce invalid ledger writes.
 * Pure (no Nest / DB imports).
 */

export type ProposalContext = {
  accounts: AccountLike[];
  categories: CategoryLike[];
  baseCurrency: string;
  timeZone: string;
  now?: Date;
  /** The user's message for this turn (date / exchange-rate evidence). */
  userText?: string;
  monthFirst?: boolean;
};

export type ProposalOutcome = {
  ok: boolean;
  payload: Record<string, any>;
  title?: string;
  summary?: string;
  /** Corrections applied automatically (shown on the card summary). */
  notes: string[];
  /** Question to ask the user when the proposal cannot be fixed safely. */
  clarification?: string;
};

type TxType = 'expense' | 'income' | 'transfer';

type Side =
  | { status: 'matched'; account: AccountLike; ref?: string }
  | { status: 'ambiguous'; candidates: AccountLike[]; ref: string }
  | { status: 'invalid'; ref: string }
  | { status: 'none' };

const SOURCE_KEYS = [
  'source_container_id',
  'source_account_id',
  'source_account',
  'source_account_name',
  'source_container_name',
  'source',
  'from_account',
  'from_account_name',
  'from',
  'paid_from',
  'paid_using',
];

const DESTINATION_KEYS = [
  'destination_container_id',
  'destination_account_id',
  'destination_account',
  'destination_account_name',
  'destination_container_name',
  'destination',
  'to_account',
  'to_account_name',
  'to',
  'deposit_to',
  'credited_to',
];

/** Helper keys models invent; removed so cards only show real fields. */
const HELPER_KEYS = [
  ...SOURCE_KEYS.filter((k) => !k.endsWith('container_id')),
  ...DESTINATION_KEYS.filter((k) => !k.endsWith('container_id')),
  'account',
  'account_name',
  'account_id',
  'category',
  'category_name',
  'transaction_type_label',
];

const SMALL_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'at',
  'in',
  'on',
  'for',
  'by',
  'via',
  'from',
  'with',
]);

const WEAK_DESCRIPTIONS =
  /^(expense|income|transfer|payment|paid|transaction|opal transaction|purchase|spent|spend|money|amount|bill|debit|credit|upi|misc|other)$/i;

const UUID_ANY_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

export function smartCase(text: string): string {
  const words = text.split(/(\s+)/);
  const allCaps = /[A-Z]{3,}/.test(text) && text === text.toUpperCase();
  let index = 0;
  return words
    .map((word) => {
      if (/^\s+$/.test(word) || !word) return word;
      const first = index === 0;
      index += 1;
      if (/\d/.test(word)) return word;
      if (/[A-Z].*[A-Z]/.test(word) && !allCaps) return word; // iPhone, DMart, HDFC
      const base = allCaps ? word.toLowerCase() : word;
      if (allCaps && base.length <= 4 && /^[a-z]+$/.test(base) && !SMALL_WORDS.has(base) && !/^(ride|cab|food|fuel|rent|bill|shop|mart|cafe|bar)$/.test(base)) {
        return word; // keep short acronyms from all-caps OCR (ATM, UPI, KFC)
      }
      if (!first && SMALL_WORDS.has(base.toLowerCase())) return base.toLowerCase();
      return base.charAt(0).toUpperCase() + base.slice(1);
    })
    .join('');
}

/** Concise, human, ≤ 80 chars; first letter capitalised, OCR caps tamed. */
export function cleanDescription(value: unknown, maxLength = 80): string {
  let text = str(value)
    .replace(UUID_ANY_RE, '')
    .replace(/[`*_#>]/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[.;,:\s]+$/, '')
    .trim();
  if (!text) return '';
  if (text === text.toUpperCase() && /[A-Z]{3,}/.test(text)) text = smartCase(text);
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (text.length > maxLength) {
    const cut = text.slice(0, maxLength + 1);
    const space = cut.lastIndexOf(' ');
    text = (space > maxLength * 0.6 ? cut.slice(0, space) : cut.slice(0, maxLength)).replace(
      /[\s,.;:–-]+$/,
      '',
    );
  }
  return text;
}

export function cleanMerchant(value: unknown): string {
  let text = str(value)
    .replace(UUID_ANY_RE, '')
    .replace(/\b(pvt\.?|private|ltd\.?|limited|llp|inc\.?|corp\.?|co\.)(?=\s|$)/gi, '')
    .replace(/\s*(#|store\s*no\.?|branch)\s*[\w-]+$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,\s-]+$/, '')
    .trim();
  if (!text || /^(self|na|n\/a|unknown|none|null)$/i.test(text)) return '';
  if (text === text.toUpperCase() || text === text.toLowerCase()) text = smartCase(text);
  return text.slice(0, 255);
}

function normalizeType(value: unknown): TxType | null {
  const raw = str(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return null;
  if (['expense', 'debit', 'spend', 'spending', 'payment', 'purchase', 'withdrawal_expense'].includes(raw)) return 'expense';
  if (['income', 'credit', 'deposit', 'refund', 'salary', 'earning', 'receipt'].includes(raw)) return 'income';
  if (['transfer', 'self_transfer', 'move', 'internal_transfer', 'own_transfer'].includes(raw)) return 'transfer';
  return null;
}

function normalizeCurrency(value: unknown): string | null {
  const raw = str(value).toUpperCase();
  if (!raw) return null;
  if (/^(₹|RS\.?|RUPEES?|INR)$/.test(raw)) return 'INR';
  if (raw === '$') return 'USD';
  if (raw === '€') return 'EUR';
  if (raw === '£') return 'GBP';
  return /^[A-Z]{3}$/.test(raw) ? raw : null;
}

function parsePositiveAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
  }
  const cleaned = str(value)
    .replace(/^(?:rs\.?|inr|usd|eur|gbp|aud|cad|sgd|aed)\s*/i, '')
    .replace(/\s*(?:inr|usd|eur|gbp|aud|cad|sgd|aed)$/i, '')
    .replace(/[\s,₹$€£¥]/g, '');
  if (!/^\+?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function formatMoney(amount: number, currency: string): string {
  const code = String(currency || '').toUpperCase();
  try {
    return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency: code || 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

function listNames(accounts: AccountLike[], limit = 6): string {
  const names = accounts.slice(0, limit).map((a) => describeAccount(a));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function resolveSide(
  payload: Record<string, any>,
  keys: string[],
  accounts: AccountLike[],
  excludeIds: string[] = [],
): Side {
  let invalidRef = '';
  for (const key of keys) {
    const raw = payload[key];
    if (raw == null || raw === '' || typeof raw === 'object') continue;
    const ref = str(raw);
    if (!ref) continue;
    if (isUuid(ref)) {
      const account = accounts.find((a) => a.id === ref);
      if (account) return { status: 'matched', account };
      invalidRef = invalidRef || ref;
      continue;
    }
    const resolved = resolveAccountRef(accounts, ref, { excludeIds });
    if (resolved.status === 'matched') return { status: 'matched', account: resolved.account, ref };
    if (resolved.status === 'ambiguous') return { status: 'ambiguous', candidates: resolved.candidates, ref };
    invalidRef = invalidRef || ref;
  }
  return invalidRef ? { status: 'invalid', ref: invalidRef } : { status: 'none' };
}

const RE = {
  cardBill:
    /\b(credit\s*card|cc|card)\b[^.]{0,40}\b(bill|dues?|outstanding|statement|repay(?:ment)?)\b|\b(bill|dues?|outstanding)\b[^.]{0,30}\b(credit\s*card|cc)\b|\bcard payment\b|\bpaid (?:off )?(?:my |the )?(?:\w+ )?(?:credit\s*)?card\b/i,
  spentWithCard: /\b(?:paid|bought|spent|swiped)\b[^.]{0,30}\b(?:with|using|via|by|on)\b[^.]{0,12}\bcard\b/i,
  atm: /\b(atm|cash withdrawal|withdr[ae]w(?:al|n)?(?: cash)?|took out cash)\b/i,
  selfMove:
    /\b(self[\s-]?transfer|transfer(?:red)? (?:to|into) (?:my|own|self)|moved? (?:money |funds )?(?:to|into)|top[\s-]?up|topped up|added money to|load(?:ed)? (?:my )?wallet|sweep)\b/i,
  invest:
    /\b(sip|invest(?:ed|ing)? (?:in|into)|bought (?:stocks?|shares|mutual funds?|gold|etf)|mutual fund purchase|lumpsum|lump sum)\b/i,
  emi: /\b(emi|loan (?:repayment|payment|instal?ment)|principal)\b/i,
  incomeWords:
    /\b(refund(?:ed)?|cash ?back|salary|payroll|stipend|interest (?:credited|received|earned)|dividend|reimburse(?:ment|d)?|received|credited)\b/i,
  spentWords: /\b(paid|spent|bought|purchased|gave|sent)\b/i,
};

function pickSingle(accounts: AccountLike[], text: string): AccountLike | null {
  if (accounts.length === 1) return accounts[0];
  if (!accounts.length) return null;
  const mentioned = accountsMentioned(accounts, text);
  if (mentioned.length === 1) return mentioned[0];
  const resolved = resolveAccountRef(accounts, text, { minScore: 50 });
  return resolved.status === 'matched' ? resolved.account : null;
}

/** Main entry for create_transaction / update_transaction / recurring payloads. */
export function validateTransactionProposal(
  actionType: string,
  input: Record<string, any>,
  ctx: ProposalContext,
): ProposalOutcome {
  const isUpdate = actionType === 'update_transaction' || actionType === 'update_recurring';
  const isRecurring = actionType === 'create_recurring' || actionType === 'update_recurring';
  const typeKey = isRecurring ? 'transaction_type' : 'type';
  const dateKey = isRecurring ? 'start_date' : 'date';
  const payload: Record<string, any> = { ...input };
  const notes: string[] = [];
  const accounts = ctx.accounts || [];
  const categories = ctx.categories || [];
  const today = todayInTimeZone(ctx.timeZone, ctx.now);
  const dateCtx = { timeZone: ctx.timeZone, now: ctx.now, monthFirst: ctx.monthFirst };
  const fail = (clarification: string): ProposalOutcome => ({
    ok: false,
    payload,
    notes,
    clarification,
  });

  const text = [payload.description, payload.merchant, payload.notes, payload.title, payload.name, payload.summary_hint]
    .map(str)
    .filter(Boolean)
    .join(' · ');
  const labelAmount = parsePositiveAmount(payload.amount);
  const labelText =
    cleanDescription(payload.description || payload.merchant || payload.name) || 'This transaction';
  const label =
    labelAmount != null
      ? `${labelText} (${formatMoney(labelAmount, normalizeCurrency(payload.currency) || ctx.baseCurrency)})`
      : labelText;

  // ---- type --------------------------------------------------------------
  const statedType = normalizeType(payload[typeKey] ?? payload.type ?? payload.transaction_type);
  let type: TxType | null = statedType ?? (isUpdate ? null : 'expense');

  // ---- accounts ------------------------------------------------------------
  const generic = payload.account ?? payload.account_name ?? payload.account_id;
  let src = resolveSide(payload, SOURCE_KEYS, accounts);
  let dst = resolveSide(
    payload,
    DESTINATION_KEYS,
    accounts,
    src.status === 'matched' ? [src.account.id] : [],
  );
  if (generic != null && str(generic)) {
    const side = resolveSide({ account: generic }, ['account'], accounts);
    if (type === 'income' && dst.status === 'none') dst = side;
    else if (src.status === 'none' && type !== 'income') src = side;
  }

  for (const [side, name] of [
    [src, 'paying'],
    [dst, 'receiving'],
  ] as const) {
    if (side.status === 'ambiguous') {
      return fail(
        `**${label}** — which ${name} account did you mean by “${side.ref}”: ${listNames(side.candidates)}?`,
      );
    }
  }

  // ---- classification ------------------------------------------------------
  if (!isUpdate && type) {
    const srcAcc = src.status === 'matched' ? src.account : null;
    let dstAcc = dst.status === 'matched' ? dst.account : null;

    if (srcAcc && dstAcc && srcAcc.id !== dstAcc.id && type !== 'transfer') {
      notes.push('Classified as a transfer — both accounts are yours.');
      type = 'transfer';
    } else if (type === 'expense' && !srcAcc && dstAcc && RE.incomeWords.test(text) && !RE.spentWords.test(text)) {
      notes.push('Classified as income (money received).');
      type = 'income';
    } else if (type === 'expense' && RE.incomeWords.test(text) && /\b(refund|cash ?back|salary|dividend|interest)\b/i.test(text) && /\b(received|credited|got|earned)\b/i.test(text) && !RE.spentWords.test(text)) {
      notes.push('Classified as income (money received).');
      type = 'income';
      if (!dstAcc && srcAcc) {
        dst = { status: 'matched', account: srcAcc };
        src = { status: 'none' };
        dstAcc = srcAcc;
      }
    }

    const isCardBill = RE.cardBill.test(text) && !RE.spentWithCard.test(text);
    if ((type === 'expense' || type === 'transfer') && isCardBill && !(dstAcc && dstAcc.type === 'credit_card')) {
      const cards = accounts.filter((a) => a.type === 'credit_card' && a.id !== srcAcc?.id);
      const card = dstAcc && dstAcc.type === 'credit_card' ? dstAcc : pickSingle(cards, text);
      if (srcAcc?.type === 'credit_card' && !dstAcc) {
        // "Paid HDFC card bill" with the card resolved as the payer.
        const banks = accounts.filter((a) => !LIABILITY_TYPES.has(String(a.type)) && a.type !== 'investment');
        const bank = pickSingle(banks, text);
        if (!bank) {
          return fail(`**${label}** — which account paid the ${srcAcc.name} bill: ${listNames(banks)}?`);
        }
        dst = { status: 'matched', account: srcAcc };
        src = { status: 'matched', account: bank };
        type = 'transfer';
        notes.push('Credit card bill payment recorded as a transfer to the card (not an expense).');
      } else if (card) {
        dst = { status: 'matched', account: card };
        type = 'transfer';
        notes.push('Credit card bill payment recorded as a transfer to the card (not an expense).');
      } else if (!cards.length) {
        return fail(
          `**${label}** looks like a credit card bill payment. Paying a card bill is a transfer to the card account, but you have no credit card account in Opal yet — add one in [Accounts](/accounts) (or tell me its name and limit and I’ll propose it), or reply “record it as an expense”.`,
        );
      } else {
        return fail(`**${label}** — which card's bill was this: ${listNames(cards)}?`);
      }
    }

    if ((type === 'expense' || type === 'transfer') && RE.atm.test(text) && !(dst.status === 'matched')) {
      const cashAccounts = accounts.filter((a) => a.type === 'cash');
      const cash = pickSingle(cashAccounts, text);
      if (cash) {
        dst = { status: 'matched', account: cash };
        type = 'transfer';
        notes.push('Cash withdrawal recorded as a transfer into your cash account.');
      } else if (!cashAccounts.length) {
        return fail(
          `**${label}** is a cash withdrawal — that moves money into cash rather than spending it. Add a Cash account in [Accounts](/accounts) (or say “create a cash account”) and I’ll record it as a transfer.`,
        );
      } else {
        return fail(`**${label}** — which cash account received it: ${listNames(cashAccounts)}?`);
      }
    }

    if (type === 'expense' && dst.status !== 'matched' && (RE.invest.test(text) || RE.selfMove.test(text) || RE.emi.test(text))) {
      const wanted = RE.invest.test(text)
        ? ['investment', 'gold', 'crypto']
        : RE.emi.test(text)
          ? ['loan']
          : ['bank', 'wallet', 'cash', 'investment'];
      const pool = accounts.filter((a) => wanted.includes(String(a.type)) && a.id !== (src.status === 'matched' ? src.account.id : ''));
      const mentioned = accountsMentioned(pool, text);
      const target = mentioned.length === 1 ? mentioned[0] : RE.invest.test(text) && pool.length === 1 ? pool[0] : null;
      if (target) {
        dst = { status: 'matched', account: target };
        type = 'transfer';
        notes.push(`Recorded as a transfer into ${target.name} (money stays yours).`);
      }
    }
  }

  // ---- required accounts ----------------------------------------------------
  const spendable = accounts.filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(String(a.type)));
  const receivable = accounts.filter((a) => ['bank', 'cash', 'wallet', 'investment'].includes(String(a.type)));
  if (src.status === 'invalid' && (type !== 'income' || isUpdate)) {
    return fail(`**${label}** — I couldn't find the account “${src.ref.slice(0, 40)}”. Which one paid: ${listNames(spendable)}?`);
  }
  if (dst.status === 'invalid' && (type !== 'expense' || isUpdate)) {
    return fail(`**${label}** — I couldn't find the account “${dst.ref.slice(0, 40)}”. Where did the money go: ${listNames(receivable)}?`);
  }
  if (!isUpdate) {
    if ((type === 'expense' || type === 'transfer') && src.status !== 'matched') {
      const only = spendable.length === 1 ? spendable[0] : null;
      if (only && type === 'expense') {
        src = { status: 'matched', account: only };
        notes.push(`Paid from ${only.name} (your only spending account).`);
      } else if (!accounts.length) {
        return fail(`**${label}** — you have no accounts in Opal yet. Add one in [Accounts](/accounts) first (or tell me its name, type and balance and I'll propose it).`);
      } else {
        return fail(`**${label}** — which account did the money come from: ${listNames(spendable.length ? spendable : accounts)}?`);
      }
    }
    if ((type === 'income' || type === 'transfer') && dst.status !== 'matched') {
      const only = receivable.length === 1 ? receivable[0] : null;
      if (only && type === 'income') {
        dst = { status: 'matched', account: only };
        notes.push(`Deposited to ${only.name} (your only account that can receive it).`);
      } else {
        const pool = (receivable.length ? receivable : accounts).filter(
          (a) => a.id !== (src.status === 'matched' ? src.account.id : ''),
        );
        return fail(`**${label}** — which account received the money: ${listNames(pool)}?`);
      }
    }
    if (type === 'transfer' && src.status === 'matched' && dst.status === 'matched' && src.account.id === dst.account.id) {
      return fail(`**${label}** — a transfer needs two different accounts; both sides resolved to ${src.account.name}. Where did the money go?`);
    }
  }

  const srcAcc = src.status === 'matched' ? src.account : null;
  const dstAcc = dst.status === 'matched' ? dst.account : null;
  for (const key of HELPER_KEYS) delete payload[key];
  if (type) payload[typeKey] = type;
  if (isRecurring) delete payload.type;
  if (type === 'expense') {
    payload.source_container_id = srcAcc?.id;
    delete payload.destination_container_id;
  } else if (type === 'income') {
    payload.destination_container_id = dstAcc?.id;
    delete payload.source_container_id;
  } else if (type === 'transfer') {
    payload.source_container_id = srcAcc?.id;
    payload.destination_container_id = dstAcc?.id;
  } else {
    // Partial update without a type: write back whatever resolved.
    if (srcAcc) payload.source_container_id = srcAcc.id;
    else delete payload.source_container_id;
    if (dstAcc) payload.destination_container_id = dstAcc.id;
    else delete payload.destination_container_id;
  }

  // ---- amount & currency -----------------------------------------------------
  let amount: number | null = null;
  if (payload.amount != null && payload.amount !== '') {
    amount = parsePositiveAmount(payload.amount);
    if (amount == null) {
      return fail(`**${label}** — what was the amount? (“${str(payload.amount).slice(0, 20)}” is not a valid positive number.)`);
    }
    payload.amount = amount;
  } else if (!isUpdate) {
    return fail(`**${label}** — what was the amount?`);
  }

  const ledgerAccount = type === 'income' ? dstAcc : srcAcc;
  const ledgerCurrency = str(ledgerAccount?.currency).toUpperCase() || null;
  const stated = normalizeCurrency(payload.currency);
  if (payload.currency != null && !stated) delete payload.currency;
  if (stated && ledgerCurrency && stated !== ledgerCurrency && amount != null) {
    try {
      const converted = convertAmount(amount, stated, ledgerCurrency);
      notes.push(
        `${formatMoney(amount, stated)} converted to ${formatMoney(converted, ledgerCurrency)} at Opal's reference rate (${ledgerAccount!.name} is in ${ledgerCurrency}) — edit if your bank charged a different amount.`,
      );
      const original = `Original amount: ${stated} ${amount.toFixed(2)}`;
      payload.notes = str(payload.notes) ? `${str(payload.notes)} · ${original}` : original;
      payload.amount = converted;
      amount = converted;
    } catch {
      return fail(
        `**${label}** — ${ledgerAccount!.name} is in ${ledgerCurrency} but the amount is in ${stated}, which I can't convert. What was the amount in ${ledgerCurrency}?`,
      );
    }
  }
  if (ledgerCurrency) payload.currency = ledgerCurrency;
  else if (stated) payload.currency = stated;

  // exchange_rate: cross-currency transfers only, and only when the user said it.
  if (payload.exchange_rate != null) {
    const rate = parsePositiveAmount(payload.exchange_rate);
    const cross =
      type === 'transfer' &&
      srcAcc &&
      dstAcc &&
      str(srcAcc.currency).toUpperCase() !== str(dstAcc.currency).toUpperCase();
    const rateStated =
      rate != null &&
      (ctx.userText == null ||
        ctx.userText.includes(String(rate)) ||
        ctx.userText.includes(str(input.exchange_rate)));
    if (!cross || !rateStated || rate == null) {
      delete payload.exchange_rate;
      if (cross && rate != null) notes.push('Exchange rate left to Opal (you did not state one).');
    } else {
      payload.exchange_rate = rate;
    }
  }

  // ---- category ------------------------------------------------------------
  const categoryText = [payload.description, payload.merchant, input.category, input.category_name, payload.notes]
    .map(str)
    .join(' ');
  let category: CategoryLike | null = null;
  if (type === 'transfer') {
    if (payload.category_id) notes.push('Category cleared — transfers are not spending.');
    delete payload.category_id;
  } else {
    const rawId = str(payload.category_id);
    if (rawId && isUuid(rawId)) {
      category = categories.find((c) => c.id === rawId) || null;
      if (!category) notes.push('Ignored an unknown category id.');
    }
    if (!category) {
      category =
        findCategoryByName(categories, input.category_name) ||
        findCategoryByName(categories, input.category) ||
        (rawId && !isUuid(rawId) ? findCategoryByName(categories, rawId) : null);
    }
    const explicit = Boolean(category);
    if (!category && (!isUpdate || rawId || input.category || input.category_name)) {
      category =
        suggestCategoryFromText(categories, categoryText, type || 'expense') ||
        (isUpdate ? null : fallbackCategory(categories, type || 'expense'));
    }
    if (category) {
      payload.category_id = category.id;
      if (!explicit) notes.push(`Category: ${category.name}.`);
    } else {
      delete payload.category_id;
    }
  }

  // ---- merchant & description ---------------------------------------------
  if (type === 'transfer') {
    delete payload.merchant;
  } else if (payload.merchant != null) {
    const merchant = cleanMerchant(payload.merchant);
    if (merchant) payload.merchant = merchant;
    else delete payload.merchant;
  } else if (!isUpdate) {
    const at = str(payload.description).match(/\b(?:at|from|to|@)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})/);
    if (at && type === 'expense') payload.merchant = cleanMerchant(at[1]);
  }

  if (payload.description != null || !isUpdate) {
    let description = cleanDescription(payload.description);
    const weak = !description || WEAK_DESCRIPTIONS.test(description) || /^transfer$/i.test(description);
    if (type === 'transfer' && srcAcc && dstAcc) {
      const genericTransfer = weak || /^(self[\s-]?)?transfer(red)?\b[^:→]*$/i.test(description) || !/[→>]|\bto\b/i.test(description);
      if (genericTransfer) {
        const prefix = dstAcc.type === 'credit_card'
          ? 'Card bill payment'
          : dstAcc.type === 'cash' && srcAcc.type !== 'cash'
            ? 'Cash withdrawal'
            : dstAcc.type === 'loan'
              ? 'Loan payment'
              : dstAcc.type === 'investment'
                ? 'Investment'
                : 'Transfer';
        description = `${prefix}: ${srcAcc.name} → ${dstAcc.name}`;
      }
    } else if (weak) {
      const merchant = str(payload.merchant);
      const name = cleanDescription(payload.name);
      if (name && isRecurring) {
        description = name;
      } else if (type === 'income') {
        description = [category?.name || 'Income', merchant].filter(Boolean).join(' – ');
      } else if (merchant && category) {
        description = `${category.name} at ${merchant}`;
      } else {
        description = merchant || name || category?.name || 'Expense';
      }
    }
    payload.description = cleanDescription(description, 80) || 'Transaction';
  }

  // ---- date (user's timezone) ---------------------------------------------
  const expressions = ctx.userText ? findDateExpressions(ctx.userText, dateCtx) : [];
  const single = expressions.length === 1 ? expressions[0] : null;
  const rawDate = payload[dateKey] ?? (isRecurring ? undefined : payload.transaction_date);
  delete payload.transaction_date;
  if (rawDate != null && str(rawDate)) {
    let date = normalizeIsoDate(rawDate) || resolveDatePhrase(str(rawDate), dateCtx);
    if (!date) {
      date = single?.date || today;
      notes.push(`Date set to ${date}.`);
    } else if (single?.relative && date !== single.date && Math.abs(diffDaysIso(date, single.date)) <= 7) {
      // Model miscounted "yesterday"/"last Friday" (usually a timezone slip).
      date = single.date;
    }
    if (!isRecurring && !isPlausibleDate(date, today)) {
      const fallback = single?.date && isPlausibleDate(single.date, today) ? single.date : today;
      notes.push(`Adjusted an out-of-range date (${date}) to ${fallback}.`);
      date = fallback;
    }
    payload[dateKey] = date;
  } else if (!isUpdate && !isRecurring) {
    payload[dateKey] = single?.date && isPlausibleDate(single.date, today) ? single.date : today;
  }
  if (isRecurring && payload.end_date != null) {
    const end = normalizeIsoDate(payload.end_date) || resolveDatePhrase(str(payload.end_date), dateCtx);
    if (end) payload.end_date = end;
    else delete payload.end_date;
  }

  if (payload.notes != null) {
    const n = str(payload.notes).replace(UUID_ANY_RE, '').slice(0, 1000);
    if (n) payload.notes = n;
    else delete payload.notes;
  }

  // ---- title & summary ------------------------------------------------------
  const typeLabel = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Transaction';
  const verb = isUpdate ? 'Update' : isRecurring ? 'Recurring' : typeLabel;
  const title = `${verb}: ${str(payload.description) || label}`.slice(0, 120);
  const parts: string[] = [];
  if (amount != null) parts.push(formatMoney(amount, str(payload.currency) || ctx.baseCurrency));
  if (srcAcc && dstAcc) parts.push(`${srcAcc.name} → ${dstAcc.name}`);
  else if (srcAcc) parts.push(`from ${srcAcc.name}`);
  else if (dstAcc) parts.push(`into ${dstAcc.name}`);
  if (category) parts.push(category.name);
  if (payload[dateKey]) parts.push(String(payload[dateKey]));
  const summary = [parts.join(' · '), ...notes].filter(Boolean).join(' ');

  return { ok: true, payload, title, summary, notes };
}

/** Lighter repair for budgets / goals / categories that reference ids. */
export function repairReferenceIds(
  actionType: string,
  input: Record<string, any>,
  ctx: Pick<ProposalContext, 'accounts' | 'categories'>,
): ProposalOutcome {
  const payload: Record<string, any> = { ...input };
  const notes: string[] = [];
  const categoryKeys = actionType.includes('category') ? ['parent_id'] : ['category_id'];
  for (const key of categoryKeys) {
    const raw = str(payload[key]);
    if (!raw) continue;
    if (isUuid(raw) && ctx.categories.some((c) => c.id === raw)) continue;
    const byName = findCategoryByName(ctx.categories, isUuid(raw) ? input.category_name : raw);
    if (byName) payload[key] = byName.id;
    else {
      delete payload[key];
      notes.push('Removed an unknown category reference.');
    }
  }
  for (const key of ['container_id', 'personal_container_id']) {
    const raw = str(payload[key]);
    if (!raw) continue;
    if (isUuid(raw) && ctx.accounts.some((a) => a.id === raw)) continue;
    const resolved = resolveAccountRef(ctx.accounts, isUuid(raw) ? '' : raw);
    if (resolved.status === 'matched') payload[key] = resolved.account.id;
    else if (resolved.status === 'ambiguous') {
      return {
        ok: false,
        payload,
        notes,
        clarification: `Which account did you mean by “${raw}”: ${listNames(resolved.candidates)}?`,
      };
    } else {
      delete payload[key];
      notes.push('Removed an unknown account reference.');
    }
  }
  delete payload.category_name;
  return { ok: true, payload, notes };
}
