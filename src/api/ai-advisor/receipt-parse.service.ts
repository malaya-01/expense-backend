import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { CategoriesService } from '../categories/categories.service';
import { AccountsService } from '../accounts/accounts.service';
import { ParseReceiptDto } from './dto/ai-advisor.dto';
import { AiOmnirouteUsageService } from './ai-omniroute-usage.service';
import { trySequentialVisionChat } from './providers/omniroute.adapter';
import { ChatMessage } from './providers/types';
import { matchExpenseSource } from './match-container';

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
  /\b(self\s*transfer|transfer\s+to\s+self|paid\s+to\s+self|to\s+yourself|own\s+account|between\s+accounts|account\s+to\s+account|moved\s+to|fund\s+transfer)\b/i;

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
): ReceiptTransactionType | null {
  const raw = asString(value)?.toLowerCase();
  if (raw === 'expense' || raw === 'income' || raw === 'transfer') return raw;
  if (TRANSFER_HINT_RE.test(haystack) || (hasDestination && /self|own/i.test(haystack))) {
    return 'transfer';
  }
  if (INCOME_HINT_RE.test(haystack)) return 'income';
  if (/\b(paid|sent|debited|payment\s+to|spent)\b/i.test(haystack)) {
    return 'expense';
  }
  return null;
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
          '  expense = user paid / sent money to a merchant or another person.',
          '  income = user received / was credited money (salary, refund received, money received).',
          '  transfer = self-pay / money moved between the user\'s own accounts or wallets (Paid to self, Self transfer).',
          'For expense: container_* / bank_name / account_* describe the paying (source) account.',
          'For income: destination_* fields describe where money was credited; container_* may be null.',
          'For transfer: container_* is the debit/source account; destination_* is the credit/destination account.',
          'merchant is the counterparty name (payee for expense, payer for income). For self-transfer use null or "Self".',
          'upi_txn_id is the UPI transaction ID. platform_txn_id is the app id (Google transaction ID, PhonePe UTR, Paytm order id). They are different.',
          'platform is the app: Google Pay, PhonePe, Paytm, BHIM, bank PDF, etc.',
          'account_label is the bank/account as shown (e.g. Karur Vysya Bank 2324). account_last4 is the last 4 digits if shown.',
          'notes is any remark/message on the screenshot, else null.',
          'container_name / destination_container_name must be one of these user accounts when it matches, else null:',
          containerNames.slice(0, 40).join(', ') || '(none)',
          'category_name must be one of these user categories when it reasonably matches, else null:',
          categoryNames.slice(0, 80).join(', ') || '(none)',
        ].join('\n'),
      },
      {
        role: 'user',
        content:
          'Extract JSON keys: merchant, description, amount, currency, date, time, payment_method, payment_status, transaction_type, upi_vpa, upi_txn_id, platform, platform_txn_id, notes, category_name, container_name, bank_name, account_last4, account_label, destination_container_name, destination_bank_name, destination_account_last4, destination_account_label.',
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

    const extracted = this.parseModelJson(vision.content);
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

    const category = await this.resolveCategory(
      userId,
      categories,
      extracted.category_name,
      extracted.merchant,
      extracted.transaction_type,
    );
    const sourceMatched = matchExpenseSource(containers, {
      container_name: extracted.container_name,
      bank_name: extracted.bank_name,
      account_last4: extracted.account_last4,
      account_label: extracted.account_label,
    });
    let destinationMatched = matchExpenseSource(containers, {
      container_name: extracted.destination_container_name,
      bank_name: extracted.destination_bank_name,
      account_last4: extracted.destination_account_last4,
      account_label: extracted.destination_account_label,
    });
    // Income receipts often only show the credited account once — reuse source hints.
    if (
      extracted.transaction_type === 'income' &&
      !destinationMatched &&
      sourceMatched
    ) {
      destinationMatched = sourceMatched;
    }

    const source = describeVisionSource(vision.model);
    const hasCore = Boolean(extracted.amount || extracted.merchant);
    return {
      ok: hasCore,
      stored: false,
      warning: hasCore
        ? undefined
        : 'AI ran but could not find a merchant or amount. Review the form before saving.',
      used_provider: source.provider,
      used_model: source.model,
      category_id: category?.id || null,
      category_name: category?.name || extracted.category_name,
      source_container_id: sourceMatched?.id || null,
      destination_container_id: destinationMatched?.id || null,
      extracted,
    };
  }

  private parseModelJson(content: string): ReceiptExtractedFields {
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
      const merchant = asString(parsed.merchant);
      const description = cleanDescription(asString(parsed.description), merchant);
      const notes = asString(parsed.notes) || lineNotes;
      const date = asDate(parsed.date) || asDate(parsed.paid_at);
      const time = asTime(parsed.time) || asTime(parsed.paid_at);
      const destinationContainer = asString(parsed.destination_container_name);
      const destinationBank = asString(parsed.destination_bank_name);
      const destinationLabel = asString(parsed.destination_account_label);
      const destinationLast4 =
        asLast4(parsed.destination_account_last4) ||
        asLast4(parsed.destination_account_label);
      const haystack = joinHaystack([
        asString(parsed.payment_status),
        description,
        notes,
        merchant,
        asString(parsed.transaction_type),
      ]);
      const paymentStatus = asPaymentStatus(parsed.payment_status, haystack);
      const transactionType = asTransactionType(
        parsed.transaction_type,
        haystack,
        Boolean(destinationContainer || destinationBank || destinationLabel),
      );
      return {
        merchant,
        description,
        amount: asAmount(parsed.amount),
        currency: asCurrency(parsed.currency),
        date,
        time,
        paid_at: paidAtFrom(date, time),
        payment_method: asString(parsed.payment_method),
        payment_status: paymentStatus,
        transaction_type: transactionType,
        upi_vpa: asString(parsed.upi_vpa),
        upi_txn_id: asString(parsed.upi_txn_id),
        platform: asString(parsed.platform),
        platform_txn_id: asString(parsed.platform_txn_id),
        notes,
        category_name: asString(parsed.category_name),
        container_name: asString(parsed.container_name),
        bank_name: asString(parsed.bank_name),
        account_last4: asLast4(parsed.account_last4) || asLast4(parsed.account_label),
        account_label: asString(parsed.account_label),
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
