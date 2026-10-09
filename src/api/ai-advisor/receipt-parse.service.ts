import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { CategoriesService } from '../categories/categories.service';
import { AccountsService } from '../accounts/accounts.service';
import { ParseReceiptDto } from './dto/ai-advisor.dto';
import { AiOmnirouteUsageService } from './ai-omniroute-usage.service';
import { trySequentialVisionChat } from './providers/omniroute.adapter';
import { ChatMessage, ProviderChatResult, ProviderConfig } from './providers/types';
import { runProviderChat } from './providers';
import { AiSettingsService } from './ai-settings.service';
import { matchExpenseSource, rankAccountMatches } from './match-container';
import {
  RECEIPT_USER_PROMPT,
  ReceiptConfidence,
  ReceiptDetails,
  ReceiptReconciliation,
  buildReceiptDescription,
  buildReceiptSystemPrompt,
  buildTotalsPassPrompt,
  detectCurrency,
  extractReceiptDetails,
  mergeTotalsPass,
  normalizeMerchantName,
  normalizePaymentMethod,
  parseLenientJson,
  reconcileTotals,
  resolveReceiptDate,
  scoreConfidence,
  secondPassReason,
  toDtoPaymentStatus,
} from './receipt-reconcile';
import { effectiveTimeZone, todayInTimeZone } from './user-dates';
import { suggestCategoryFromText } from './category-matcher';
import { ObjectStorageService } from 'src/storage/object-storage.service';
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
  stored: boolean;
  receipt_id?: string | null;
  receipt_url?: string | null;
  warning?: string;
  blocked_reason?: 'failed_payment' | 'pending_payment';
  used_provider: string | null;
  used_model: string | null;
  category_id: string | null;
  category_name: string | null;
  source_container_id: string | null;
  destination_container_id: string | null;
  extracted: ReceiptExtractedFields;
  /** Additive: full bill breakdown (taxes, line items, ids). */
  details?: Omit<ReceiptDetails, 'model_confidence'>;
  /** Additive: how the amount was chosen / whether totals add up. */
  reconciliation?: ReceiptReconciliation;
  /** Additive: 0–1 per key field plus overall. */
  confidence?: ReceiptConfidence;
  /** Additive: 1, or 2 when a focused totals/date re-read ran. */
  passes?: number;
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
    let cleaned = value.replace(/\s/g, '').replace(/[₹$€£]/g, '');
    // "12,50" is a decimal comma when it is the only/last separator, is
    // followed by exactly two digits and there is no dot; otherwise commas
    // are thousands separators ("1,250" → 1250).
    if (!cleaned.includes('.') && /,\d{2}$/.test(cleaned)) {
      const idx = cleaned.lastIndexOf(',');
      cleaned = `${cleaned.slice(0, idx).replace(/,/g, '')}.${cleaned.slice(idx + 1)}`;
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
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

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function asDate(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return validMonthDay(Number(iso[2]), Number(iso[3]))
      ? `${iso[1]}-${iso[2]}-${iso[3]}`
      : null;
  }
  const named = raw.match(
    /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:$|[,\s])/,
  );
  if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    if (month && validMonthDay(Number(month), Number(named[1]))) {
      return `${named[3]}-${month}-${named[1].padStart(2, '0')}`;
    }
  }
  const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    // Default D/M/Y (Indian receipts); switch to M/D/Y only when the second
    // number cannot be a month but the first can.
    const [dayNum, monthNum] =
      first <= 12 && second > 12 ? [second, first] : [first, second];
    if (!validMonthDay(monthNum, dayNum)) return null;
    let year = dmy[3];
    if (year.length === 2) year = `20${year}`;
    if (year.length !== 4) return null;
    return `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
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

/** "+05:30" style offset of `timeZone` on that calendar date. */
function utcOffsetFor(timeZone: string, date: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(`${date}T12:00:00Z`))
      .find((part) => part.type === 'timeZoneName')?.value;
    const match = String(name || '').match(/GMT([+-]\d{2}):?(\d{2})?/);
    if (match) return `${match[1]}:${match[2] || '00'}`;
    if (/^GMT$/.test(String(name))) return '+00:00';
  } catch {
    /* fall through */
  }
  return '+05:30';
}

/**
 * Preserve the receipt's printed wall-clock time in the user's timezone.
 * Do not use `new Date(y,m,d,h,min)` on the server — Render/UTC would shift IST by ~5.5h.
 */
function paidAtFrom(
  date: string | null,
  time: string | null,
  timeZone = 'Asia/Kolkata',
): string | null {
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
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${utcOffsetFor(timeZone, date)}`;
}

const BYOK_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  vertex: 'Vertex AI',
};

function describeByokSource(result: ProviderChatResult): {
  provider: string;
  model: string;
} {
  return {
    provider: BYOK_LABELS[result.provider] || result.provider,
    model: result.model,
  };
}

/** Providers / models that can read a receipt image (and PDFs where noted). */
function visionCapable(config: ProviderConfig, mime: string): boolean {
  const model = String(config.model || '').toLowerCase();
  const pdf = mime === 'application/pdf';
  switch (config.provider) {
    case 'anthropic':
    case 'vertex':
      return true;
    case 'openai':
      return !pdf && /(gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|^o[134])/.test(model);
    case 'openrouter':
      return (
        !pdf &&
        /(gpt-4o|gpt-4\.1|gpt-5|claude|gemini|gemma-3|qwen.*vl|llama-4|pixtral|mistral-(small|medium)-3)/.test(
          model,
        )
      );
    default:
      return false;
  }
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

function descriptionIsWeak(
  description: string | null,
  merchant: string | null,
): boolean {
  const text = (description || '').trim();
  if (!text) return true;
  const merchantName = (merchant || '').trim();
  if (merchantName && normalizeName(text) === normalizeName(merchantName)) {
    return true;
  }
  if (
    /^(self|payment|upi|paid|sent|transfer|money sent|successful|payment successful)$/i.test(
      text,
    )
  ) {
    return true;
  }
  return /^(paid|sent|payment|transfer)\s+(to|from)\b/i.test(text);
}

function noteIsOnlyReference(note: string): boolean {
  const text = note.trim();
  return (
    /^(upi|utr|txn|ref|rrn|transaction id)\b/i.test(text) ||
    /^[A-Z0-9-]{12,}$/i.test(text)
  );
}

function categoryFromNote(note: string, names: string[]): string | null {
  const ranked = [...names]
    .filter((name) => normalizeName(name).length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const name of ranked) {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (pattern.test(note)) return name;
  }
  return null;
}

/**
 * GPay / PhonePe / Paytm "Note" is the user's own purpose. Use it for the
 * description and category when the receipt itself only shows a payee.
 */
function applyNoteInsights(
  fields: ReceiptExtractedFields,
  categoryNames: string[],
): ReceiptExtractedFields {
  const note = fields.notes?.trim() || null;
  if (!note || noteIsOnlyReference(note)) return fields;
  const category = fields.category_name || categoryFromNote(note, categoryNames);
  const description = descriptionIsWeak(fields.description, fields.merchant)
    ? note
    : fields.description;
  return {
    ...fields,
    notes: note,
    category_name: category,
    description,
  };
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
    private readonly storage: ObjectStorageService,
    private readonly settings: AiSettingsService,
  ) {}

  async parse(userId: string, dto: ParseReceiptDto): Promise<ReceiptParseResult> {
    const mime = dto.mime_type === 'image/jpg' ? 'image/jpeg' : dto.mime_type;
    const saved = await this.persistReceipt(userId, dto, mime);
    const finish = (result: ReceiptParseResult): ReceiptParseResult => {
      const out: ReceiptParseResult = saved
        ? {
            ...result,
            stored: true,
            receipt_id: saved.id,
            receipt_url: saved.url,
          }
        : result;
      // CreateTransactionDto only accepts SUCCESS / FAILURE / SUBMITTED /
      // CANCELLED / UNKNOWN; lowercase values made the scanned form fail
      // validation on save.
      out.extracted = {
        ...out.extracted,
        payment_status: toDtoPaymentStatus(out.extracted.payment_status),
      };
      void this.recordExtraction(userId, saved?.id, out);
      if (saved && (out.extracted.date || out.extracted.merchant)) {
        // File the scan under the bill date / merchant
        // (receipts/{YYYY}/{MM}/{yyyymmdd}-{merchant}-...). Best-effort;
        // the token in receipt_url never changes.
        void this.storage.relocateFile(saved.fileId, userId, {
          date: out.extracted.date,
          label: out.extracted.merchant,
        });
      }
      return out;
    };

    const [categories, containers, profileRow] = await Promise.all([
      this.categories.findAll(userId),
      this.accounts.findAll(userId),
      this.pgPool
        .query(
          `SELECT full_name, currency, timezone FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        )
        .then((r) => r.rows[0] || {})
        .catch(() => ({}) as Record<string, any>),
    ]);
    const categoryNames = categories.map((row: { name: string }) => row.name);
    const containerNames = containers.map(
      (row: { name: string; institution?: string | null; type?: string }) =>
        row.institution ? `${row.name} (${row.institution})` : row.name,
    );
    const userFullName = asString(profileRow.full_name);
    const baseCurrency = String(profileRow.currency || 'USD').toUpperCase();
    const timeZone = effectiveTimeZone(profileRow.timezone, baseCurrency);
    const today = todayInTimeZone(timeZone);
    const skipGroq = mime === 'application/pdf';

    const system = buildReceiptSystemPrompt({
      today,
      timeZone,
      baseCurrency,
      userFullName,
      categoryNames,
      accountLabels: containerNames,
    });
    const attachment = {
      name: dto.name || 'receipt',
      mimeType: mime,
      dataBase64: dto.data_base64,
    };
    const messagesFor = (instruction: string): ChatMessage[] => [
      { role: 'system', content: system },
      { role: 'user', content: instruction, attachments: [attachment] },
    ];

    // Route: the user's own vision-capable provider when active (stronger
    // models, no free quota), else Opal Free vision (Groq → Gemini).
    let byok = await this.resolveVisionProvider(userId, mime);
    let quotaChecked = false;
    const runVision = async (
      instruction: string,
    ): Promise<{ result: ProviderChatResult | null; errors: string[]; viaFree: boolean; blocked?: boolean }> => {
      if (byok) {
        try {
          const result = await runProviderChat(byok, messagesFor(instruction), 4096);
          return { result, errors: [], viaFree: false };
        } catch (error: any) {
          console.warn(`[Opal receipts] ${byok.provider} vision failed, using Opal Free: ${error?.message || error}`);
          byok = null;
        }
      }
      if (!quotaChecked) {
        quotaChecked = true;
        const quota = await this.omnirouteUsage.getUsage(userId);
        if (quota.remaining <= 0) return { result: null, errors: [], viaFree: true, blocked: true };
      }
      const { result, errors } = await trySequentialVisionChat(messagesFor(instruction), {
        skipGroq,
        maxTokens: 3072,
      });
      return { result, errors, viaFree: true };
    };

    const first = await runVision(RECEIPT_USER_PROMPT);
    if (first.blocked) {
      return finish(
        emptyResult(
          'Daily free AI limit reached. Fill the transaction from the receipt yourself. The scan image was saved.',
        ),
      );
    }
    if (!first.result) {
      const hint = first.errors
        .map((item) => item.replace(/key[=:][^\s]+/gi, 'key=***'))
        .slice(0, 2)
        .join(' · ');
      return finish(emptyResult(
        hint
          ? `Could not read this receipt (${hint}). Fill the form manually. The scan image was saved.`
          : 'Could not read this receipt with free AI or Gemini. Fill the form manually. The scan image was saved.',
      ));
    }
    if (first.viaFree) {
      await this.omnirouteUsage.recordSuccessfulRequest(userId).catch(() => undefined);
    }
    const source = first.viaFree
      ? describeVisionSource(first.result.model)
      : describeByokSource(first.result);

    const json = parseLenientJson(first.result.content) || {};
    let details = extractReceiptDetails(json);
    let extractedRaw = this.parseModelJson(json, userFullName);
    let reconciliation = reconcileTotals(details);
    const dateHints = { currency: asCurrency(json.currency), baseCurrency, timeZone };
    let dateResult = resolveReceiptDate(json.date ?? json.paid_at, details.date_raw, dateHints);
    const isPaymentScreen =
      details.document_type === 'upi_payment' ||
      details.document_type === 'bank_transfer' ||
      Boolean(extractedRaw.platform || extractedRaw.upi_txn_id);
    let passes = 1;

    // Focused second pass on the totals / date when the first reading does
    // not reconcile or has low confidence.
    const reason =
      extractedRaw.payment_status === 'failed'
        ? null
        : secondPassReason({
            reconciliation,
            details,
            date: dateResult.date,
            isPayment: isPaymentScreen,
          });
    if (reason) {
      const second = await runVision(buildTotalsPassPrompt(details, reason));
      const json2 = second.result ? parseLenientJson(second.result.content) : null;
      if (json2) {
        passes = 2;
        details = mergeTotalsPass(details, extractReceiptDetails(json2));
        reconciliation = reconcileTotals(details);
        const date2 = resolveReceiptDate(json2.date ?? json.date, details.date_raw, {
          ...dateHints,
          currency: asCurrency(json2.currency) || dateHints.currency,
        });
        if (date2.date && (!dateResult.date || date2.confidence > dateResult.confidence)) {
          dateResult = date2;
        }
        if (!extractedRaw.time) extractedRaw = { ...extractedRaw, time: asTime(json2.time) };
        if (!json.currency && json2.currency) json.currency = json2.currency;
      }
    }

    const evidence = [
      details.merchant_tax_id ? `gstin ${details.merchant_tax_id}` : '',
      details.taxes.map((t) => t.label).join(' '),
      details.merchant_address,
      extractedRaw.platform,
      extractedRaw.upi_vpa ? 'upi' : '',
      details.total_label,
    ]
      .filter(Boolean)
      .join(' ');
    const currency = detectCurrency(json.currency ?? extractedRaw.currency, evidence, baseCurrency);
    const merchant =
      extractedRaw.merchant && /^self$/i.test(extractedRaw.merchant)
        ? extractedRaw.merchant
        : normalizeMerchantName(extractedRaw.merchant);
    const time = extractedRaw.time;
    const fields: ReceiptExtractedFields = {
      ...extractedRaw,
      merchant,
      amount: reconciliation.total ?? extractedRaw.amount,
      currency: currency.currency,
      date: dateResult.date,
      time,
      paid_at: paidAtFrom(dateResult.date, time, timeZone),
      payment_method: normalizePaymentMethod(extractedRaw.payment_method, details.card_last4),
      account_last4: extractedRaw.account_last4 || details.card_last4,
      notes:
        extractedRaw.notes ||
        (details.invoice_number ? `Invoice ${details.invoice_number}` : null),
    };

    const extracted = applyNoteInsights(fields, categoryNames);
    const status = extracted.payment_status;
    if (status === 'failed') {
      return finish(emptyResult(
        'This looks like a failed payment. It was not added as a transaction. The scan image was saved.',
        {
          blocked_reason: 'failed_payment',
          used_provider: source.provider,
          used_model: source.model,
          extracted,
        },
      ));
    }
    if (status === 'pending') {
      return finish(emptyResult(
        'This payment is still pending. Wait for success before adding it. The scan image was saved.',
        {
          blocked_reason: 'pending_payment',
          used_provider: source.provider,
          used_model: source.model,
          extracted,
        },
      ));
    }

    const resolved = this.resolveTransferAccounts(containers, extracted);
    Object.assign(extracted, resolved.extracted);

    let category = await this.resolveCategory(
      userId,
      categories,
      extracted.category_name,
      extracted.merchant,
      extracted.transaction_type,
    );
    if (!category && extracted.transaction_type !== 'transfer') {
      // Semantic fallback over the user's own categories (never invented).
      category = suggestCategoryFromText(
        categories,
        [
          extracted.merchant,
          details.merchant_legal_name,
          details.document_type?.replace(/_/g, ' '),
          extracted.description,
          extracted.notes,
          details.line_items.slice(0, 8).map((item) => item.name).join(' '),
        ]
          .filter(Boolean)
          .join(' '),
        extracted.transaction_type || 'expense',
      );
    }

    if (extracted.transaction_type !== 'transfer') {
      extracted.description =
        buildReceiptDescription({
          modelDescription: extracted.description,
          merchant: extracted.merchant,
          documentType: details.document_type,
          categoryName: category?.name || extracted.category_name,
          lineItems: details.line_items,
        }) || extracted.description;
    }

    const confidence = scoreConfidence({
      details,
      reconciliation,
      merchant: extracted.merchant,
      dateConfidence: dateResult.date ? dateResult.confidence : 0,
      currencyConfidence: currency.confidence,
      categoryMatched: Boolean(category),
    });

    const hasCore = Boolean(
      extracted.amount ||
        extracted.merchant ||
        extracted.transaction_type === 'transfer',
    );
    const warnings = [
      hasCore ? resolved.warning : 'AI ran but could not find a merchant or amount. Review the form before saving.',
      reconciliation.status === 'mismatch'
        ? 'The bill totals do not add up — please double-check the amount.'
        : null,
      dateResult.note && !dateResult.date ? `${dateResult.note} Pick the date manually.` : null,
      hasCore && confidence.overall < 0.5 ? 'Low-confidence scan — review every field before saving.' : null,
    ].filter(Boolean) as string[];

    return finish({
      ok: hasCore,
      stored: Boolean(saved),
      warning: warnings.length ? warnings.join(' ') : undefined,
      used_provider: source.provider,
      used_model: source.model,
      category_id: category?.id || null,
      category_name: category?.name || extracted.category_name,
      source_container_id: resolved.sourceId,
      destination_container_id: resolved.destinationId,
      extracted,
      details: {
        document_type: details.document_type,
        merchant_legal_name: details.merchant_legal_name,
        merchant_address: details.merchant_address,
        merchant_tax_id: details.merchant_tax_id,
        invoice_number: details.invoice_number,
        date_raw: details.date_raw,
        subtotal: details.subtotal,
        taxes: details.taxes,
        tax_total: details.tax_total,
        discount_total: details.discount_total,
        tip: details.tip,
        service_charge: details.service_charge,
        round_off: details.round_off,
        grand_total: details.grand_total,
        amount_paid: details.amount_paid,
        total_label: details.total_label,
        card_last4: details.card_last4,
        card_network: details.card_network,
        line_items: details.line_items,
      },
      reconciliation,
      confidence,
      passes,
    });
  }

  /** The user's active provider when it can read this file type, else null. */
  private async resolveVisionProvider(
    userId: string,
    mime: string,
  ): Promise<ProviderConfig | null> {
    if (String(process.env.RECEIPT_USE_ACTIVE_PROVIDER || 'true').toLowerCase() === 'false') {
      return null;
    }
    try {
      const { config } = await this.settings.loadActiveProviderConfig(userId);
      return visionCapable(config, mime) ? config : null;
    } catch {
      return null;
    }
  }

  /** Best-effort audit of what was extracted onto the stored receipt row. */
  private async recordExtraction(
    userId: string,
    receiptId: string | undefined,
    result: ReceiptParseResult,
  ): Promise<void> {
    if (!receiptId) return;
    try {
      await this.pgPool.query(
        `UPDATE receipts
         SET extracted_data = $3::jsonb,
             confidence_score = $4,
             processing_status = $5,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [
          receiptId,
          userId,
          JSON.stringify({
            extracted: result.extracted,
            details: result.details ?? null,
            reconciliation: result.reconciliation ?? null,
            category_id: result.category_id,
            used_provider: result.used_provider,
            used_model: result.used_model,
            passes: result.passes ?? 0,
            warning: result.warning ?? null,
          }),
          result.confidence ? Math.min(1, Math.max(0, result.confidence.overall)) : null,
          result.ok ? 'processed' : result.blocked_reason ? 'blocked' : 'failed',
        ],
      );
    } catch {
      /* audit only */
    }
  }

  private async persistReceipt(
    userId: string,
    dto: ParseReceiptDto,
    mime: string,
  ): Promise<{ id: string; url: string; fileId: string } | null> {
    try {
      const body = Buffer.from(dto.data_base64 || '', 'base64');
      if (!body.length || body.length > 8 * 1024 * 1024) return null;
      const saved = await this.storage.saveFile({
        userId,
        kind: 'receipt',
        body,
        mimeType: mime || 'image/jpeg',
        filename: dto.name,
      });
      const inserted = await this.pgPool.query(
        `INSERT INTO receipts
          (user_id, original_filename, file_path, file_size, mime_type, processing_status,
           stored_file_id)
         VALUES ($1, $2, $3, $4, $5, 'stored', $6)
         RETURNING id`,
        [
          userId,
          (dto.name || 'receipt').slice(0, 255),
          saved.objectKey,
          body.length,
          saved.mimeType,
          saved.id,
        ],
      );
      return {
        id: inserted.rows[0].id as string,
        url: saved.publicPath,
        fileId: saved.id,
      };
    } catch {
      return null;
    }
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

  /** Flat transaction fields from the (leniently parsed) model JSON. */
  private parseModelJson(
    parsed: Record<string, unknown>,
    userFullName?: string | null,
  ): ReceiptExtractedFields {
    try {
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
            .slice(0, 500) || null
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
        amount: asAmount(parsed.grand_total ?? parsed.amount),
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
