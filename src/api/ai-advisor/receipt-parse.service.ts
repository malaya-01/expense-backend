import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { CategoriesService } from '../categories/categories.service';
import { ParseReceiptDto } from './dto/ai-advisor.dto';
import { AiOmnirouteUsageService } from './ai-omniroute-usage.service';
import { trySequentialVisionChat } from './providers/omniroute.adapter';
import { ChatMessage } from './providers/types';

export type ReceiptExtractedFields = {
  merchant: string | null;
  description: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  payment_method: string | null;
  upi_vpa: string | null;
  upi_txn_id: string | null;
  notes: string | null;
  category_name: string | null;
};

export type ReceiptParseResult = {
  ok: boolean;
  stored: false;
  warning?: string;
  used_provider: string | null;
  used_model: string | null;
  category_id: string | null;
  category_name: string | null;
  extracted: ReceiptExtractedFields;
};

const EMPTY_FIELDS: ReceiptExtractedFields = {
  merchant: null,
  description: null,
  amount: null,
  currency: null,
  date: null,
  payment_method: null,
  upi_vpa: null,
  upi_txn_id: null,
  notes: null,
  category_name: null,
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
  const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    let year = dmy[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

@Injectable()
export class ReceiptParseService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    private readonly categories: CategoriesService,
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
    const categoryNames = categories.map((row: { name: string }) => row.name);
    const skipGroq = mime === 'application/pdf';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You extract purchase receipts, UPI payment screenshots, invoices, and bills.',
          'Return a JSON object only. Never invent IDs, accounts, or amounts that are not visible.',
          'Use null for any field you cannot read. Amount is the total paid (not subtotal).',
          'Prefer ISO currency codes (INR, USD). Dates as YYYY-MM-DD.',
          'category_name must be one of these user categories when it reasonably matches, else null:',
          categoryNames.slice(0, 80).join(', ') || '(none)',
        ].join('\n'),
      },
      {
        role: 'user',
        content:
          'Extract this receipt into JSON with keys: merchant, description, amount, currency, date, payment_method, upi_vpa, upi_txn_id, notes, category_name, line_items.',
        attachments: [
          {
            name: dto.name || 'receipt',
            mimeType: mime,
            dataBase64: dto.data_base64,
          },
        ],
      },
    ];

    const vision = await trySequentialVisionChat(messages, { skipGroq });
    if (!vision) {
      return emptyResult(
        'Could not read this receipt with free AI or Gemini. Fill the form manually — the image was not saved.',
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
      extracted,
    };
  }

  private parseModelJson(content: string): ReceiptExtractedFields {
    try {
      const parsed = JSON.parse(stripJsonFence(content)) as Record<string, unknown>;
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
      const description =
        asString(parsed.description) || merchant || asString(parsed.notes);
      return {
        merchant,
        description,
        amount: asAmount(parsed.amount),
        currency: asCurrency(parsed.currency),
        date: asDate(parsed.date),
        payment_method: asString(parsed.payment_method),
        upi_vpa: asString(parsed.upi_vpa),
        upi_txn_id: asString(parsed.upi_txn_id),
        notes: asString(parsed.notes) || lineNotes,
        category_name: asString(parsed.category_name),
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
