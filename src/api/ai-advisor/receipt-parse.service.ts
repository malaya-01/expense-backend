import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { CategoriesService } from '../categories/categories.service';
import { AccountsService } from '../accounts/accounts.service';
import { ParseReceiptDto } from './dto/ai-advisor.dto';
import { AiOmnirouteUsageService } from './ai-omniroute-usage.service';
import { trySequentialVisionChat } from './providers/omniroute.adapter';
import { ChatMessage } from './providers/types';
import { matchExpenseSource } from './match-container';

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
};

export type ReceiptParseResult = {
  ok: boolean;
  stored: false;
  warning?: string;
  used_provider: string | null;
  used_model: string | null;
  category_id: string | null;
  category_name: string | null;
  source_container_id: string | null;
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
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
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

function paidAtFrom(date: string | null, time: string | null): string | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0, 0).toISOString();
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanDescription(description: string | null, merchant: string | null) {
  if (!description) return merchant;
  if (/^(to|from)\s+/i.test(description) && merchant) return merchant;
  return description;
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
          'You extract UPI payment screenshots, GPay/PhonePe/Paytm receipts, invoices, and bills.',
          'Return a JSON object only. Never invent IDs, accounts, amounts, or times that are not visible.',
          'Use null for any field you cannot read. Amount is the total paid.',
          'Dates as YYYY-MM-DD. Times as 24-hour HH:mm (8:39 pm -> 20:39).',
          'upi_txn_id is the UPI transaction ID. platform_txn_id is the app id (Google transaction ID, PhonePe UTR, Paytm order id). They are different.',
          'platform is the app: Google Pay, PhonePe, Paytm, BHIM, etc.',
          'account_label is the paying bank/account as shown (e.g. Karur Vysya Bank 2324). account_last4 is the last 4 digits if shown.',
          'notes is any remark/message on the screenshot, else null.',
          'container_name must be one of these user accounts when it matches the paying account, else null:',
          containerNames.slice(0, 40).join(', ') || '(none)',
          'category_name must be one of these user categories when it reasonably matches, else null:',
          categoryNames.slice(0, 80).join(', ') || '(none)',
        ].join('\n'),
      },
      {
        role: 'user',
        content:
          'Extract JSON keys: merchant, description, amount, currency, date, time, payment_method, payment_status, upi_vpa, upi_txn_id, platform, platform_txn_id, notes, category_name, container_name, bank_name, account_last4, account_label.',
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
          ? `Could not read this receipt (${hint}). Fill the form manually — the image was not saved.`
          : 'Could not read this receipt with free AI or Gemini. Fill the form manually — the image was not saved.',
      );
    }

    await this.omnirouteUsage.recordSuccessfulRequest(userId).catch(() => undefined);

    const extracted = this.parseModelJson(vision.content);
    const category = await this.resolveCategory(
      userId,
      categories,
      extracted.category_name,
      extracted.merchant,
    );
    const matched = matchExpenseSource(containers, {
      container_name: extracted.container_name,
      bank_name: extracted.bank_name,
      account_last4: extracted.account_last4,
      account_label: extracted.account_label,
    });

    const hasCore = Boolean(extracted.amount || extracted.merchant);
    return {
      ok: hasCore,
      stored: false,
      warning: hasCore
        ? undefined
        : 'AI ran but could not find a merchant or amount. Review the form before saving.',
      used_provider: vision.provider,
      used_model: vision.model,
      category_id: category?.id || null,
      category_name: category?.name || extracted.category_name,
      source_container_id: matched?.id || null,
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
      const date = asDate(parsed.date) || asDate(parsed.paid_at);
      const time = asTime(parsed.time) || asTime(parsed.paid_at);
      return {
        merchant,
        description: cleanDescription(asString(parsed.description), merchant),
        amount: asAmount(parsed.amount),
        currency: asCurrency(parsed.currency),
        date,
        time,
        paid_at: paidAtFrom(date, time),
        payment_method: asString(parsed.payment_method),
        payment_status: asString(parsed.payment_status),
        upi_vpa: asString(parsed.upi_vpa),
        upi_txn_id: asString(parsed.upi_txn_id),
        platform: asString(parsed.platform),
        platform_txn_id: asString(parsed.platform_txn_id),
        notes: asString(parsed.notes) || lineNotes,
        category_name: asString(parsed.category_name),
        container_name: asString(parsed.container_name),
        bank_name: asString(parsed.bank_name),
        account_last4: asLast4(parsed.account_last4) || asLast4(parsed.account_label),
        account_label: asString(parsed.account_label),
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
  ): Promise<{ id: string; name: string } | null> {
    if (merchant) {
      const history = await this.pgPool.query(
        `SELECT category_id
         FROM ledger_transactions
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND type = 'expense'
           AND category_id IS NOT NULL
           AND lower(trim(coalesce(merchant, ''))) = lower($2)
         GROUP BY category_id
         ORDER BY COUNT(*) DESC, MAX(date) DESC
         LIMIT 1`,
        [userId, merchant.trim()],
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
