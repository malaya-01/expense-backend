import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { CategoriesService } from '../categories/categories.service';
import { AccountsService } from '../accounts/accounts.service';
import { ParseReceiptDto } from './dto/ai-advisor.dto';
import { AiOmnirouteUsageService } from './ai-omniroute-usage.service';
import { trySequentialVisionChat } from './providers/omniroute.adapter';
import { ChatMessage } from './providers/types';
import { matchExpenseSource, rankAccountMatches } from './match-container';
import type { ReceiptAccountHint } from './match-container';

export type ReceiptTransactionType = 'expense' | 'income' | 'transfer';

export type ReceiptExtractedFields = {
  merchant: string | null;
  description: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  time: string | null;
  paid_at: string | null;
  payment_method: string | null;
  payment_status: string | null;
  transaction_type: ReceiptTransactionType | null;
  upi_vpa: string | null;
  upi_txn_id: string | null;
  platform: string | null;
  platform_txn_id: string | null;
  notes: string | null;
  category_name: string | null;
  container_name: string | null;
  bank_name: string | null;
  account_last4: string | null;
  account_label: string | null;
  destination_container_name: string | null;
  destination_bank_name: string | null;
  destination_account_last4: string | null;
  destination_account_label: string | null;
};

export type ReceiptParseResult = {
  ok: boolean;
  stored: false;
  warning?: string;
  blocked_reason?: 'failed_payment' | 'pending_payment';
  used_provider: string | null;
  used_model: string | null;
  category_id: string | null;
  category_name: string | null;
  source_container_id: string | null;
  destination_container_id: string | null;
  extracted: ReceiptExtractedFields;
};

const EMPTY_FIELDS: ReceiptExtractedFields = {
  merchant: null,
  description: null,
  amount: null,
  currency: null,
  date: null,
  time: null,
  paid_at: null,
  payment_method: null,
  payment_status: null,
  transaction_type: null,
  upi_vpa: null,
  upi_txn_id: null,
  platform: null,
  platform_txn_id: null,
  notes: null,
  category_name: null,
  container_name: null,
  bank_name: null,
  account_last4: null,
  account_label: null,
  destination_container_name: null,
  destination_bank_name: null,
  destination_account_last4: null,
  destination_account_label: null,
};

const MONTHS: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

const FAILED_STATUS_RE =
  /\b(fail(?:ed|ure)?|declin(?:ed|e)|unsuccessful|not\s+successful|couldn['’]?t\s+pay|payment\s+not\s+done|transaction\s+not\s+complet|rejected|cancelled|canceled|error|timed?\s*out|debit\s+failed|insufficient)\b/i;

const PENDING_STATUS_RE =
  /\b(pending|processing|in\s+progress|awaiting|initiated|submitted)\b/i;

const SUCCESS_STATUS_RE =
  /\b(success(?:ful)?|completed?|paid|done|credited|received|debited|settled)\b/i;

const INCOME_HINT_RE =
  /\b(received|credited|credit\s+alert|money\s+received|payment\s+received|you\s+got|got\s+paid|salary|refund\s+received|incoming)\b/i;

const TRANSFER_HINT_RE =
  /\b(self\s*transfer|transfer\s+to\s*self|paid\s+to\s*self|to\s+yourself|own\s+account|between\s+(?:my\s+)?accounts|account\s+to\s+account|moved\s+to|fund\s+transfer|bank\s+transfer|neft|imps|rtgs|self\s*pay|money\s+sent\s+to\s+(?:your|own)|credited\s+to\s+your|transferred\s+to\s+(?:your|bank)|wallet\s+to\s+bank|bank\s+to\s+bank)\b/i;

const SELF_PAYEE_RE =
  /\b(self|myself|yourself|my\s+account|own\s+upi|to\s+self)\b/i;

function emptyResult(
  warning: string,
  extra?: Partial<ReceiptParseResult>,
): ReceiptParseResult {
  return {
    ok: false,
    stored: false,
    warning,
    used_provider: null,
    used_model: null,
    category_id: null,
    category_name: null,
    source_container_id: null,
    destination_container_id: null,
    extracted: { ...EMPTY_FIELDS },
    ...extra,
  };
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function asAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value * 100) / 100;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[, ]/g, '').replace(/[₹$€£]/g, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed * 100) / 100;
    }
  }
  return null;
}

function asCurrency(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/^(RS|INR|₹|RUPEE|RUPEES)$/.test(upper) || upper.includes('RUPEE')) {
    return 'INR';
  }
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  return null;
}

function asDate(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = raw.match(
    /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:$|[,\s])/,
  );
  if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    if (month) return `${named[3]}-${month}-${named[1].padStart(2, '0')}`;
  }
  const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    let year = dmy[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }
  return null;
}

function asTime(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  // Prefer the wall-clock time printed on the receipt; ignore trailing timezone labels.
  const match = raw.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(?:ist|india|in|utc|gmt|[+-]\d{2}:?\d{2}))?$/i,
  );
  if (!match) {
    const embedded = raw.match(
      /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i,
    );
    if (!embedded) return null;
    return asTime(
      `${embedded[1]}:${embedded[2]}${embedded[4] ? ` ${embedded[4]}` : ''}`,
    );
  }
  let hour = Number(match[1]);
  const minute = match[2];
  const meridian = (match[4] || '').toLowerCase();
  if (meridian === 'pm' && hour < 12) hour += 12;
  if (meridian === 'am' && hour === 12) hour = 0;
  if (hour > 23 || Number(minute) > 59) return null;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function asLast4(value: unknown): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * Preserve the receipt's printed wall-clock time.
 * Do not use `new Date(y,m,d,h,min)` on the server — Render/UTC would shift IST by ~5.5h.
 * UPI / Indian bank receipts are treated as Asia/Kolkata.
 */
function paidAtFrom(date: string | null, time: string | null): string | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (!year || !month || !day) return null;
  if (
    hour == null ||
    minute == null ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`;
}

function describeVisionSource(modelId: string | null | undefined): {
  provider: string;
  model: string;
} {
  const raw = String(modelId || '').trim();
  if (!raw) return { provider: 'Opal Free', model: 'unknown' };
  if (/gemini/i.test(raw)) {
    const match = raw.match(/gemini-[\w.-]+/i);
    return { provider: 'Gemini', model: match?.[0] || 'gemini-3.6-flash' };
  }
  if (/groq/i.test(raw) || /qwen\//i.test(raw)) {
    const qwen = raw.match(/qwen\/[\w.-]+/i);
    if (qwen) return { provider: 'Groq', model: qwen[0] };
    const after = raw.replace(/^groq:/i, '').split('/')[0];
    return { provider: 'Groq', model: after || raw };
  }
  return { provider: 'Opal Free', model: raw };
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanDescription(description: string | null, merchant: string | null) {
  if (!description) return merchant;
  if (/^(to|from)\s+/i.test(description) && merchant) return merchant;
  return description;
}

function joinHaystack(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

function asPaymentStatus(value: unknown, haystack: string): string | null {
  const raw = asString(value);
  const text = joinHaystack([raw, haystack]);
  if (!text) return raw;
  if (FAILED_STATUS_RE.test(text)) return 'failed';
  if (PENDING_STATUS_RE.test(text) && !SUCCESS_STATUS_RE.test(text)) {
    return 'pending';
  }
  if (raw && SUCCESS_STATUS_RE.test(raw)) return 'success';
  if (SUCCESS_STATUS_RE.test(text)) return 'success';
  return raw ? raw.toLowerCase() : null;
}

function asTransactionType(
  value: unknown,
  haystack: string,
  hasDestination: boolean,
  looksLikeSelfPayee: boolean,
): ReceiptTransactionType | null {
  const raw = asString(value)?.toLowerCase();
  if (raw === 'expense' || raw === 'income' || raw === 'transfer') {
    // Model often mislabels self-pay as expense — override when evidence is strong.
    if (
      raw === 'expense' &&
      (TRANSFER_HINT_RE.test(haystack) ||
        looksLikeSelfPayee ||
        (hasDestination && SELF_PAYEE_RE.test(haystack)))
    ) {
      return 'transfer';
    }
    return raw;
  }
  if (
    TRANSFER_HINT_RE.test(haystack) ||
    looksLikeSelfPayee ||
    (hasDestination && SELF_PAYEE_RE.test(haystack))
  ) {
    return 'transfer';
  }
  if (INCOME_HINT_RE.test(haystack) && !/\b(paid\s+to|sent\s+to|debited)\b/i.test(haystack)) {
    return 'income';
  }
  if (/\b(paid|sent|debited|payment\s+to|spent)\b/i.test(haystack)) {
    return 'expense';
  }
  return null;
}

function namesLikelySamePerson(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = normalizeName(a).replace(/\b(mr|mrs|ms|shri|smt)\b/g, '').trim();
  const right = normalizeName(b).replace(/\b(mr|mrs|ms|shri|smt)\b/g, '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const leftParts = left.split(' ').filter((p) => p.length > 1);
  const rightParts = right.split(' ').filter((p) => p.length > 1);
  if (!leftParts.length || !rightParts.length) return false;
  // "Ravi Kumar" vs "Ravi K" / same first+last token overlap
  const shared = leftParts.filter((p) => rightParts.includes(p));
  if (shared.length >= 2) return true;
  if (
    leftParts[0] === rightParts[0] &&
    leftParts[0].length >= 3 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }
  return false;
}

/** Split "From HDFC ••••1234 to SBI ••••5678" style blurbs into two account hints. */
function splitFromToAccounts(text: string | null | undefined): {
  sourceLabel: string | null;
  destinationLabel: string | null;
} {
  const raw = String(text || '').trim();
  if (!raw) return { sourceLabel: null, destinationLabel: null };
  const match =
    raw.match(
      /(?:from|debited\s+from|paid\s+using|using)\s+(.+?)\s+(?:to|credited\s+to|into|towards)\s+(.+)$/i,
    ) ||
    raw.match(/^(.+?)\s*(?:→|->|➜|»)\s*(.+)$/);
  if (!match) return { sourceLabel: null, destinationLabel: null };
  return {
    sourceLabel: match[1].trim() || null,
    destinationLabel: match[2].trim() || null,
  };
}

function hintFromParts(
  container: string | null,
  bank: string | null,
  last4: string | null,
  label: string | null,
): ReceiptAccountHint {
  return {
    container_name: container,
    bank_name: bank,
    account_last4: last4,
    account_label: label,
  };
}

@Injectable()
export class ReceiptParseService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    private readonly categories: CategoriesService,
    private readonly accounts: AccountsService,
    private readonly omnirouteUsage: AiOmnirouteUsageService,
  ) {}

  async parse(userId: string, dto: ParseReceiptDto): Promise<ReceiptParseResult> {
    const mime = dto.mime_type === 'image/jpg' ? 'image/jpeg' : dto.mime_type;
    const quota = await this.omnirouteUsage.getUsage(userId);
    if (quota.remaining <= 0) {
      return emptyResult(
        'Daily free AI limit reached. Fill the transaction from the receipt yourself — nothing was stored.',
      );
    }

    const categories = await this.categories.findAll(userId);
    const containers = await this.accounts.findAll(userId);
    const categoryNames = categories.map((row: { name: string }) => row.name);
    const containerNames = containers.map(
      (row: { name: string; institution?: string | null }) =>
        row.institution ? `${row.name} (${row.institution})` : row.name,
    );
    const userNameRow = await this.pgPool.query(
      `SELECT full_name FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const userFullName = asString(userNameRow.rows[0]?.full_name);
    const skipGroq = mime === 'application/pdf';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You extract UPI payment screenshots, GPay/PhonePe/Paytm receipts, bank PDFs, invoices, and bills.',
          'Return a JSON object only. Never invent IDs, accounts, amounts, or times that are not visible.',
          'Use null for any field you cannot read. Amount is the total shown.',
          'Dates as YYYY-MM-DD. Times as 24-hour HH:mm exactly as printed on the receipt (8:39 pm -> 20:39).',
          'Do NOT convert the printed time to UTC or any other timezone. Keep the wall-clock time shown.',
          'payment_status must be one of: success, failed, pending (or null).',
          '  failed = Failed / Declined / Unsuccessful / Payment not done / Cancelled / Error.',
          '  pending = Pending / Processing / In progress.',
          '  success = Successful / Paid / Completed / Credited / Received.',
          'transaction_type must be one of: expense, income, transfer.',
          '  expense = user paid / sent money to a merchant or another person (not themselves).',
          '  income = user received / was credited money from someone else (salary, refund, money received).',
          '  transfer = money moved between the user\'s OWN banks/wallets (self-pay / bank-to-bank / Paid to self).',
          'CRITICAL — bank-to-bank / self-transfer (very common in India):',
          '  - GPay/PhonePe "Paid to [user\'s own name]", "Transfer to self", "Self transfer", NEFT/IMPS between own accounts → transaction_type = transfer.',
          '  - If payee name matches the account holder / looks like the same person paying themselves → transfer (not expense).',
          '  - Always fill BOTH sides when two accounts are shown:',
          '      container_*/bank_name/account_* = debit / From / Paid using / Debited from account.',
          '      destination_* = credit / To / Credited to / Transferred to account.',
          '  - Example: From "HDFC ••••4521" to "SBI ••••8890" → bank_name=HDFC, account_last4=4521, destination_bank_name=SBI, destination_account_last4=8890, transaction_type=transfer.',
          '  - merchant for self-transfer: null or "Self" (never invent a shop name).',
          'For expense: container_* describe the paying account; destination_* usually null.',
          'For income: destination_* = credited account; container_* may be null.',
          userFullName
            ? `The app user\'s name is "${userFullName}". If the receipt payee/payer is this person (or clearly the same person), prefer transaction_type=transfer when money moved between banks/wallets.`
            : 'If the payee looks like the same person as the payer (self), use transaction_type=transfer.',
          'upi_txn_id is the UPI transaction ID. platform_txn_id is the app id (Google transaction ID, PhonePe UTR, Paytm order id). They are different.',
          'platform is the app: Google Pay, PhonePe, Paytm, BHIM, bank PDF, etc.',
          'account_label / destination_account_label are the bank/account strings exactly as shown (e.g. "Karur Vysya Bank 2324").',
          'notes is any remark/message on the screenshot, else null.',
          'container_name / destination_container_name must be one of these user accounts when it matches, else null:',
          containerNames.slice(0, 40).join(', ') || '(none)',
          'category_name must be one of these user categories when it reasonably matches, else null. Prefer "Transfers" for self-transfers:',
          categoryNames.slice(0, 80).join(', ') || '(none)',
        ].join('\n'),
      },
      {
        role: 'user',
        content:
          'Extract JSON keys: merchant, description, amount, currency, date, time, payment_method, payment_status, transaction_type, upi_vpa, upi_txn_id, platform, platform_txn_id, notes, category_name, container_name, bank_name, account_last4, account_label, destination_container_name, destination_bank_name, destination_account_last4, destination_account_label. If this is a self/bank-to-bank transfer, set transaction_type to transfer and fill both source and destination account fields.',
        attachments: [
          {
            name: dto.name || 'receipt',
            mimeType: mime,
            dataBase64: dto.data_base64,
          },
        ],
      },
    ];

    const { result: vision, errors } = await trySequentialVisionChat(
      messages,
      { skipGroq },
    );
    if (!vision) {
      const hint = errors
        .map((item) => item.replace(/key[=:][^\s]+/gi, 'key=***'))
        .slice(0, 2)
        .join(' · ');
      return emptyResult(
        hint
          ? `Could not read this receipt (${hint}). Fill the form manually — the file was not saved.`
          : 'Could not read this receipt with free AI or Gemini. Fill the form manually — the file was not saved.',
      );
    }

    await this.omnirouteUsage.recordSuccessfulRequest(userId).catch(() => undefined);

    const extracted = this.parseModelJson(vision.content, userFullName);
    const status = extracted.payment_status;
    if (status === 'failed') {
      const source = describeVisionSource(vision.model);
      return emptyResult(
        'This looks like a failed payment. It was not added as a transaction — nothing was stored.',
        {
          blocked_reason: 'failed_payment',
          used_provider: source.provider,
          used_model: source.model,
          extracted,
        },
      );
    }
    if (status === 'pending') {
      const source = describeVisionSource(vision.model);
      return emptyResult(
        'This payment is still pending. Wait for success before adding it — nothing was stored.',
        {
          blocked_reason: 'pending_payment',
          used_provider: source.provider,
          used_model: source.model,
          extracted,
        },
      );
    }

    const resolved = this.resolveTransferAccounts(containers, extracted);
    Object.assign(extracted, resolved.extracted);

    const category = await this.resolveCategory(
      userId,
      categories,
      extracted.category_name,
      extracted.merchant,
      extracted.transaction_type,
    );

    const source = describeVisionSource(vision.model);
    const hasCore = Boolean(
      extracted.amount ||
        extracted.merchant ||
        extracted.transaction_type === 'transfer',
    );
    return {
      ok: hasCore,
      stored: false,
      warning: hasCore
        ? resolved.warning
        : 'AI ran but could not find a merchant or amount. Review the form before saving.',
      used_provider: source.provider,
      used_model: source.model,
      category_id: category?.id || null,
      category_name: category?.name || extracted.category_name,
      source_container_id: resolved.sourceId,
      destination_container_id: resolved.destinationId,
      extracted,
    };
  }

  /**
   * Force bank-to-bank / self-pay into transfer and map From/To onto two
   * different user containers whenever the receipt evidence allows.
   */
  private resolveTransferAccounts(
    containers: Array<{
      id: string;
      name: string;
      type?: string;
      institution?: string | null;
    }>,
    extracted: ReceiptExtractedFields,
  ): {
    extracted: ReceiptExtractedFields;
    sourceId: string | null;
    destinationId: string | null;
    warning?: string;
  } {
    let next = { ...extracted };
    const paymentMethodHint = hintFromParts(
      null,
      null,
      null,
      next.payment_method,
    );
    let sourceHint = hintFromParts(
      next.container_name,
      next.bank_name,
      next.account_last4,
      next.account_label || next.payment_method,
    );
    let destinationHint = hintFromParts(
      next.destination_container_name,
      next.destination_bank_name,
      next.destination_account_last4,
      next.destination_account_label,
    );

    // Recover From → To when the model stuffed both sides into one field.
    if (!destinationHint.account_label && !destinationHint.bank_name) {
      for (const blob of [
        next.description,
        next.notes,
        next.account_label,
        next.payment_method,
      ]) {
        const split = splitFromToAccounts(blob);
        if (split.sourceLabel && split.destinationLabel) {
          if (!sourceHint.account_label && !sourceHint.bank_name) {
            sourceHint = hintFromParts(null, null, null, split.sourceLabel);
          }
          destinationHint = hintFromParts(
            null,
            null,
            null,
            split.destinationLabel,
          );
          break;
        }
      }
    }

    let sourceMatched = matchExpenseSource(containers, sourceHint);
    if (!sourceMatched && paymentMethodHint.account_label) {
      sourceMatched = matchExpenseSource(containers, paymentMethodHint);
    }

    let destinationMatched = matchExpenseSource(containers, destinationHint, {
      excludeIds: sourceMatched ? [sourceMatched.id] : [],
    });

    // If destination hint was empty/weak but source matched, try ranking the
    // destination label and the source label's second-best against other accounts.
    if (!destinationMatched && sourceMatched) {
      const alt = rankAccountMatches(containers, destinationHint, {
        excludeIds: [sourceMatched.id],
        minScore: 35,
      })[0];
      if (alt) destinationMatched = alt.row;
    }

    // Both banks visible but AI only filled one side — use second-best on a
    // combined "all text" hint excluding the source.
    if (sourceMatched && !destinationMatched) {
      const combined = hintFromParts(
        null,
        null,
        null,
        [
          next.destination_account_label,
          next.destination_bank_name,
          next.description,
          next.notes,
          next.account_label,
          next.payment_method,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      destinationMatched = matchExpenseSource(containers, combined, {
        excludeIds: [sourceMatched.id],
        minScore: 45,
      });
    }

    // Two different user accounts matched → this is a transfer even if the
    // model said expense.
    if (
      sourceMatched &&
      destinationMatched &&
      sourceMatched.id !== destinationMatched.id
    ) {
      next.transaction_type = 'transfer';
      if (!next.category_name) next.category_name = 'Transfers';
      if (next.merchant && /^self$/i.test(next.merchant)) next.merchant = null;
    } else if (
      next.transaction_type === 'transfer' &&
      sourceMatched &&
      destinationMatched &&
      sourceMatched.id === destinationMatched.id
    ) {
      // Avoid same-account transfer — clear destination so the user can pick.
      destinationMatched = null;
    }

    let warning: string | undefined;
    if (next.transaction_type === 'transfer') {
      if (!sourceMatched || !destinationMatched) {
        warning =
          'Detected a bank-to-bank / self transfer. Confirm the From and To accounts before saving.';
      }
      if (!next.description || /^self$/i.test(next.description)) {
        const fromName = sourceMatched?.name;
        const toName = destinationMatched?.name;
        next.description =
          fromName && toName
            ? `Transfer · ${fromName} → ${toName}`
            : 'Account transfer';
      }
    }

    return {
      extracted: next,
      sourceId: sourceMatched?.id || null,
      destinationId:
        next.transaction_type === 'income'
          ? destinationMatched?.id || sourceMatched?.id || null
          : destinationMatched?.id || null,
      warning,
    };
  }

  private parseModelJson(
    content: string,
    userFullName?: string | null,
  ): ReceiptExtractedFields {
    try {
      const cleaned = String(content || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
      const parsed = JSON.parse(stripJsonFence(cleaned)) as Record<string, unknown>;
      const lineNotes = Array.isArray(parsed.line_items)
        ? parsed.line_items
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const row = item as { name?: unknown; amount?: unknown };
              const name = asString(row.name);
              if (!name) return null;
              const amount = asAmount(row.amount);
              return amount ? `${name} ${amount}` : name;
            })
            .filter(Boolean)
            .join(', ')
        : null;
      let merchant = asString(parsed.merchant);
      const description = cleanDescription(asString(parsed.description), merchant);
      const notes = asString(parsed.notes) || lineNotes;
      const date = asDate(parsed.date) || asDate(parsed.paid_at);
      const time = asTime(parsed.time) || asTime(parsed.paid_at);
      let destinationContainer = asString(parsed.destination_container_name);
      let destinationBank = asString(parsed.destination_bank_name);
      let destinationLabel = asString(parsed.destination_account_label);
      let destinationLast4 =
        asLast4(parsed.destination_account_last4) ||
        asLast4(parsed.destination_account_label);
      let containerName = asString(parsed.container_name);
      let bankName = asString(parsed.bank_name);
      let accountLabel = asString(parsed.account_label);
      let accountLast4 =
        asLast4(parsed.account_last4) || asLast4(parsed.account_label);
      const paymentMethod = asString(parsed.payment_method);

      // Recover From/To if packed into description / payment method.
      if (!destinationLabel && !destinationBank) {
        for (const blob of [description, notes, accountLabel, paymentMethod]) {
          const split = splitFromToAccounts(blob);
          if (split.sourceLabel && split.destinationLabel) {
            if (!accountLabel && !bankName) {
              accountLabel = split.sourceLabel;
              accountLast4 = asLast4(split.sourceLabel);
            }
            destinationLabel = split.destinationLabel;
            destinationLast4 = asLast4(split.destinationLabel);
            break;
          }
        }
      }

      const haystack = joinHaystack([
        asString(parsed.payment_status),
        description,
        notes,
        merchant,
        asString(parsed.transaction_type),
        paymentMethod,
        accountLabel,
        destinationLabel,
        bankName,
        destinationBank,
      ]);
      const looksLikeSelfPayee =
        SELF_PAYEE_RE.test(haystack) ||
        namesLikelySamePerson(merchant, userFullName || null) ||
        /^self$/i.test(merchant || '');
      const hasDestination = Boolean(
        destinationContainer || destinationBank || destinationLabel,
      );
      const paymentStatus = asPaymentStatus(parsed.payment_status, haystack);
      let transactionType = asTransactionType(
        parsed.transaction_type,
        haystack,
        hasDestination,
        looksLikeSelfPayee,
      );

      if (looksLikeSelfPayee && transactionType !== 'income') {
        transactionType = 'transfer';
        if (merchant && (namesLikelySamePerson(merchant, userFullName || null) || /^self$/i.test(merchant))) {
          merchant = 'Self';
        }
      }

      return {
        merchant,
        description,
        amount: asAmount(parsed.amount),
        currency: asCurrency(parsed.currency),
        date,
        time,
        paid_at: paidAtFrom(date, time),
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        transaction_type: transactionType,
        upi_vpa: asString(parsed.upi_vpa),
        upi_txn_id: asString(parsed.upi_txn_id),
        platform: asString(parsed.platform),
        platform_txn_id: asString(parsed.platform_txn_id),
        notes,
        category_name: asString(parsed.category_name),
        container_name: containerName,
        bank_name: bankName,
        account_last4: accountLast4,
        account_label: accountLabel,
        destination_container_name: destinationContainer,
        destination_bank_name: destinationBank,
        destination_account_last4: destinationLast4,
        destination_account_label: destinationLabel,
      };
    } catch {
      return { ...EMPTY_FIELDS };
    }
  }

  private async resolveCategory(
    userId: string,
    categories: Array<{ id: string; name: string }>,
    suggestedName: string | null,
    merchant: string | null,
    transactionType: ReceiptTransactionType | null,
  ): Promise<{ id: string; name: string } | null> {
    const historyType = transactionType || 'expense';
    if (merchant && historyType !== 'transfer') {
      const history = await this.pgPool.query(
        `SELECT category_id
         FROM ledger_transactions
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND type = $3
           AND category_id IS NOT NULL
           AND lower(trim(coalesce(merchant, ''))) = lower($2)
         GROUP BY category_id
         ORDER BY COUNT(*) DESC, MAX(date) DESC
         LIMIT 1`,
        [userId, merchant.trim(), historyType],
      );
      const historyId = history.rows[0]?.category_id as string | undefined;
      if (historyId) {
        const match = categories.find((row) => row.id === historyId);
        if (match) return match;
      }
    }

    if (!suggestedName && transactionType === 'transfer') {
      const transfers = categories.find(
        (row) => normalizeName(row.name) === 'transfers',
      );
      if (transfers) return transfers;
    }

    if (!suggestedName) return null;
    const wanted = normalizeName(suggestedName);
    const exact = categories.find((row) => normalizeName(row.name) === wanted);
    if (exact) return exact;
    const partial = categories.find(
      (row) =>
        normalizeName(row.name).includes(wanted) ||
        wanted.includes(normalizeName(row.name)),
    );
    return partial || null;
  }
}
