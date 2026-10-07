import {
  diffDaysIso,
  isPlausibleDate,
  isoFromParts,
  prefersMonthFirst,
  todayInTimeZone,
} from './user-dates';
import { cleanDescription, cleanMerchant } from './transaction-proposal';

/**
 * Receipt / bill extraction spec, lenient JSON parsing, totals
 * reconciliation, date disambiguation and confidence scoring.
 * Pure (no Nest / DB imports) so it is unit-testable standalone.
 */

export type ReceiptLineItem = {
  name: string;
  qty: number | null;
  unit_price: number | null;
  amount: number | null;
};

export type ReceiptTaxLine = {
  label: string;
  kind: string;
  rate: number | null;
  amount: number;
};

export type ReceiptConfidence = {
  merchant: number;
  total: number;
  date: number;
  currency: number;
  category: number;
  overall: number;
};

export type ReceiptReconciliation = {
  status: 'ok' | 'adjusted' | 'mismatch' | 'derived' | 'missing';
  total: number | null;
  source: 'grand_total' | 'amount_paid' | 'computed' | 'line_items' | 'none';
  expected_total: number | null;
  difference: number | null;
  line_items_total: number | null;
  notes: string[];
};

export type ReceiptDetails = {
  document_type: string | null;
  merchant_legal_name: string | null;
  merchant_address: string | null;
  merchant_tax_id: string | null;
  invoice_number: string | null;
  date_raw: string | null;
  subtotal: number | null;
  taxes: ReceiptTaxLine[];
  tax_total: number | null;
  discount_total: number | null;
  tip: number | null;
  service_charge: number | null;
  round_off: number | null;
  grand_total: number | null;
  amount_paid: number | null;
  total_label: string | null;
  card_last4: string | null;
  card_network: string | null;
  line_items: ReceiptLineItem[];
  model_confidence: Partial<Record<'merchant' | 'total' | 'date' | 'currency' | 'category', number>>;
};

export const DOCUMENT_TYPES = [
  'receipt',
  'tax_invoice',
  'invoice',
  'bill',
  'utility_bill',
  'fuel',
  'restaurant',
  'grocery',
  'pharmacy',
  'ecommerce',
  'travel',
  'upi_payment',
  'bank_transfer',
  'card_slip',
  'bank_statement',
  'other',
] as const;

// ---------------------------------------------------------------------------
// Lenient JSON
// ---------------------------------------------------------------------------

/**
 * Parse a model reply into an object. Handles ```json fences, <think> blocks,
 * prose around the object, and replies cut off by the token cap (the
 * object is closed at the last complete value).
 */
export function parseLenientJson(content: string): Record<string, unknown> | null {
  let text = String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fenced?.[1] && fenced[1].includes('{')) text = fenced[1];
  const start = text.indexOf('{');
  if (start < 0) return null;
  text = text.slice(start);
  const end = text.lastIndexOf('}');
  const attempts = end > 0 ? [text.slice(0, end + 1), text] : [text];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try repair */
    }
  }
  return repairTruncatedJson(text);
}

function repairTruncatedJson(text: string): Record<string, unknown> | null {
  const cuts: Array<{ index: number; stack: string[] }> = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length) cuts.push({ index: i + 1, stack: [...stack] });
    } else if (ch === ',' && stack.length) {
      cuts.push({ index: i, stack: [...stack] });
    }
  }
  const close = (s: string[]) =>
    s
      .slice()
      .reverse()
      .map((c) => (c === '{' ? '}' : ']'))
      .join('');
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 80; k -= 1, tries += 1) {
    const cut = cuts[k];
    try {
      const parsed = JSON.parse(text.slice(0, cut.index) + close(cut.stack));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* earlier cut */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field coercion
// ---------------------------------------------------------------------------

export function toAmount(value: unknown, options?: { allowNegative?: boolean; allowZero?: boolean }): number | null {
  let n: number | null = null;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    let cleaned = value
      .trim()
      .replace(/^(?:rs\.?|inr|usd|eur|gbp|aed|sgd|aud|cad)\s*/i, '')
      .replace(/\s*(?:rs\.?|inr|usd|eur|gbp|aed|sgd|aud|cad|\/-)$/i, '')
      .replace(/[\s₹$€£¥]/g, '');
    const negative = /^\(.*\)$/.test(cleaned) || /^-/.test(cleaned) || /-$/.test(cleaned);
    cleaned = cleaned.replace(/[()+-]/g, '');
    if (!cleaned.includes('.') && /,\d{2}$/.test(cleaned)) {
      const idx = cleaned.lastIndexOf(',');
      cleaned = `${cleaned.slice(0, idx).replace(/[,.]/g, '')}.${cleaned.slice(idx + 1)}`;
    } else if (/\.\d{3},\d{2}$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
    if (/^\d+(?:\.\d+)?$|^\.\d+$/.test(cleaned)) n = Number(cleaned) * (negative ? -1 : 1);
  }
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 0 && !options?.allowNegative) return null;
  if (n === 0 && !options?.allowZero) return null;
  if (Math.abs(n) > 1e10) return null;
  return Math.round(n * 100) / 100;
}

function toRate(value: unknown): number | null {
  const n = toAmount(typeof value === 'string' ? value.replace('%', '') : value);
  return n != null && n > 0 && n <= 100 ? n : null;
}

function str(value: unknown, max = 200): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || /^(null|n\/a|na|none|unknown|-)$/i.test(text)) return null;
  return text.slice(0, max);
}

function confidenceOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  const scaled = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, scaled));
}

function taxKind(label: string): string {
  const l = label.toLowerCase();
  if (/cgst/.test(l)) return 'CGST';
  if (/sgst/.test(l)) return 'SGST';
  if (/utgst/.test(l)) return 'UTGST';
  if (/igst/.test(l)) return 'IGST';
  if (/cess/.test(l)) return 'CESS';
  if (/vat/.test(l)) return 'VAT';
  if (/gst|hst|pst/.test(l)) return 'GST';
  if (/service tax/.test(l)) return 'SERVICE_TAX';
  if (/sales tax|tax/.test(l)) return 'SALES_TAX';
  return 'TAX';
}

export function extractReceiptDetails(parsed: Record<string, any>): ReceiptDetails {
  const totals = (parsed.totals && typeof parsed.totals === 'object' ? parsed.totals : {}) as Record<string, any>;
  const pick = (key: string) => parsed[key] ?? totals[key];

  const taxes: ReceiptTaxLine[] = [];
  const rawTaxes = Array.isArray(parsed.taxes) ? parsed.taxes : Array.isArray(totals.taxes) ? totals.taxes : [];
  for (const item of rawTaxes.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const amount = toAmount((item as any).amount);
    if (amount == null) continue;
    const label = str((item as any).label ?? (item as any).name ?? (item as any).type, 60) || 'Tax';
    taxes.push({ label, kind: taxKind(label), rate: toRate((item as any).rate), amount });
  }

  const lineItems: ReceiptLineItem[] = [];
  const rawItems = Array.isArray(parsed.line_items) ? parsed.line_items : [];
  for (const item of rawItems.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const name = str((item as any).name ?? (item as any).description, 120);
    if (!name) continue;
    const qty = toAmount((item as any).qty ?? (item as any).quantity);
    const unit = toAmount((item as any).unit_price ?? (item as any).rate ?? (item as any).price);
    let amount = toAmount((item as any).amount ?? (item as any).total);
    if (amount == null && qty != null && unit != null) amount = Math.round(qty * unit * 100) / 100;
    lineItems.push({ name, qty, unit_price: unit, amount });
  }

  const confidence = (parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {}) as Record<string, unknown>;
  const docType = str(parsed.document_type, 40)?.toLowerCase().replace(/[\s-]+/g, '_') || null;
  const roundOff = toAmount(pick('round_off'), { allowNegative: true });
  const cardLast4 = String(parsed.card_last4 ?? '').replace(/\D/g, '').slice(-4);

  return {
    document_type: docType && (DOCUMENT_TYPES as readonly string[]).includes(docType) ? docType : docType ? 'other' : null,
    merchant_legal_name: str(parsed.merchant_legal_name, 160),
    merchant_address: str(parsed.merchant_address, 300),
    merchant_tax_id: str(parsed.merchant_tax_id ?? parsed.gstin ?? parsed.vat_number, 40),
    invoice_number: str(parsed.invoice_number ?? parsed.bill_number, 60),
    date_raw: str(parsed.date_raw, 40),
    subtotal: toAmount(pick('subtotal')),
    taxes,
    tax_total: toAmount(pick('tax_total')),
    discount_total: toAmount(pick('discount_total') ?? pick('discount')),
    tip: toAmount(pick('tip')),
    service_charge: toAmount(pick('service_charge')),
    round_off: roundOff != null && Math.abs(roundOff) < 5 ? roundOff : null,
    grand_total: toAmount(pick('grand_total') ?? parsed.amount ?? parsed.total),
    amount_paid: toAmount(pick('amount_paid')),
    total_label: str(pick('total_label'), 60),
    card_last4: cardLast4.length === 4 ? cardLast4 : null,
    card_network: str(parsed.card_network, 30),
    line_items: lineItems,
    model_confidence: {
      merchant: confidenceOf(confidence.merchant),
      total: confidenceOf(confidence.total ?? confidence.amount),
      date: confidenceOf(confidence.date),
      currency: confidenceOf(confidence.currency),
      category: confidenceOf(confidence.category),
    },
  };
}

// ---------------------------------------------------------------------------
// Totals reconciliation
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Decide the transaction amount from the printed totals:
 * total ≈ subtotal + tax − discount + tip + service charge ± round-off.
 * Prefers the printed grand total; never accepts a subtotal / tax line as
 * the total when the arithmetic says otherwise.
 */
export function reconcileTotals(d: ReceiptDetails): ReceiptReconciliation {
  const notes: string[] = [];
  const taxSum = d.taxes.length ? round2(d.taxes.reduce((s, t) => s + t.amount, 0)) : null;
  let tax = d.tax_total ?? taxSum;
  if (d.tax_total != null && taxSum != null && !near(d.tax_total, taxSum, 0.05)) {
    // A printed "Total tax" that equals one CGST/SGST half is a misread.
    if (d.taxes.some((t) => near(t.amount, d.tax_total!, 0.01)) && d.taxes.length > 1) {
      tax = taxSum;
      notes.push('Used the sum of tax lines (the printed tax total matched a single tax line).');
    }
  }
  const lineTotal = d.line_items.length
    ? round2(d.line_items.reduce((s, item) => s + (item.amount ?? 0), 0))
    : null;

  const base = d.subtotal ?? null;
  const expected =
    base != null
      ? round2(
          base +
            (tax ?? 0) -
            (d.discount_total ?? 0) +
            (d.tip ?? 0) +
            (d.service_charge ?? 0) +
            (d.round_off ?? 0),
        )
      : null;

  const scale = Math.max(d.grand_total ?? 0, expected ?? 0, d.amount_paid ?? 0);
  // Unprinted rounding (₹ bills round to the rupee) is allowed up to 1 unit.
  const tol = Math.max(0.05, scale * 0.005) + (d.round_off == null ? 1 : 0);

  const result = (
    status: ReceiptReconciliation['status'],
    total: number | null,
    source: ReceiptReconciliation['source'],
  ): ReceiptReconciliation => ({
    status,
    total: total != null && total > 0 ? round2(total) : null,
    source: total != null && total > 0 ? source : 'none',
    expected_total: expected,
    difference: total != null && expected != null ? round2(total - expected) : null,
    line_items_total: lineTotal,
    notes,
  });

  const grand = d.grand_total;
  const paid = d.amount_paid;

  if (grand != null) {
    const looksLikeSubtotal =
      base != null && near(grand, base, 0.01) && (tax ?? 0) > 0.01 && expected != null && expected > grand + tol;
    const looksLikeTax =
      (tax != null && near(grand, tax, 0.01)) || d.taxes.some((t) => near(t.amount, grand, 0.01));
    if (looksLikeSubtotal || looksLikeTax) {
      notes.push(
        looksLikeSubtotal
          ? 'The value read as the total equals the subtotal before tax; used the computed total.'
          : 'The value read as the total equals a tax line; used the computed total.',
      );
      if (paid != null && expected != null && near(paid, expected, tol)) return result('adjusted', paid, 'amount_paid');
      if (expected != null) return result('adjusted', expected, 'computed');
      if (paid != null && !near(paid, grand, 0.01)) return result('adjusted', paid, 'amount_paid');
    }
    if (expected == null) {
      if (lineTotal != null && !near(lineTotal, grand, tol) && lineTotal > grand * 1.5) {
        notes.push('Line items add up to more than the printed total; kept the printed total.');
        return result('mismatch', grand, 'grand_total');
      }
      return result('ok', grand, 'grand_total');
    }
    if (near(grand, expected, tol)) return result('ok', grand, 'grand_total');
    if (paid != null && near(paid, expected, tol)) {
      notes.push('Printed total did not add up; the amount paid matches subtotal + tax.');
      return result('adjusted', paid, 'amount_paid');
    }
    notes.push(
      `Printed total ${grand} differs from subtotal + tax − discount (${expected}); kept the printed total.`,
    );
    return result('mismatch', grand, 'grand_total');
  }

  if (paid != null) {
    if (expected != null && !near(paid, expected, tol) && paid > expected) {
      // Cash tendered (with change) — the bill amount is the computed total.
      notes.push('Amount tendered exceeds the bill; used the computed total.');
      return result('derived', expected, 'computed');
    }
    return result(expected != null && near(paid, expected, tol) ? 'ok' : 'derived', paid, 'amount_paid');
  }
  if (expected != null) {
    notes.push('No grand total printed/read; computed from subtotal and taxes.');
    return result('derived', expected, 'computed');
  }
  if (lineTotal != null) {
    const withTax = round2(lineTotal + (tax ?? 0) - (d.discount_total ?? 0));
    notes.push('No total read; summed the line items.');
    return result('derived', withTax, 'line_items');
  }
  return result('missing', null, 'none');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function expandYear(raw: string): number | null {
  if (raw.length === 4) return Number(raw);
  if (raw.length === 2) return 2000 + Number(raw);
  return null;
}

/** All valid readings of one printed date (ambiguous numeric dates give two). */
export function interpretDate(raw: string, monthFirst: boolean): string[] {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return [];
  let m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const iso = isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? [iso] : [];
  }
  m = text.match(/(\d{1,2})(?:st|nd|rd|th)?[\s-/.]*([a-z]{3,9})\.?[\s-/.,']*(\d{2,4})/);
  if (m && (MONTHS[m[2].slice(0, 4)] ?? MONTHS[m[2].slice(0, 3)])) {
    const month = MONTHS[m[2].slice(0, 4)] ?? MONTHS[m[2].slice(0, 3)];
    const year = expandYear(m[3]);
    const iso = year ? isoFromParts(year, month, Number(m[1])) : null;
    return iso ? [iso] : [];
  }
  m = text.match(/([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/);
  if (m && (MONTHS[m[1].slice(0, 4)] ?? MONTHS[m[1].slice(0, 3)])) {
    const month = MONTHS[m[1].slice(0, 4)] ?? MONTHS[m[1].slice(0, 3)];
    const year = expandYear(m[3]);
    const iso = year ? isoFromParts(year, month, Number(m[2])) : null;
    return iso ? [iso] : [];
  }
  m = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = expandYear(m[3]);
    if (!year) return [];
    const dmy = isoFromParts(year, b, a);
    const mdy = isoFromParts(year, a, b);
    const ordered = monthFirst ? [mdy, dmy] : [dmy, mdy];
    return [...new Set(ordered.filter((d): d is string => Boolean(d)))];
  }
  return [];
}

export type ReceiptDateHints = {
  /** Currency detected on the document (wins over the user's base currency). */
  currency?: string | null;
  baseCurrency?: string | null;
  timeZone: string;
  now?: Date;
};

/**
 * Pick the receipt date: re-reads the printed date with DD/MM vs MM/DD from
 * currency / country hints, rejects impossible dates (more than 1 day in
 * the future or older than 10 years) and falls back to the other reading or
 * the model's ISO value. Returns null when nothing plausible remains.
 */
export function resolveReceiptDate(
  modelDate: unknown,
  rawPrinted: unknown,
  hints: ReceiptDateHints,
): { date: string | null; confidence: number; note?: string } {
  const today = todayInTimeZone(hints.timeZone, hints.now);
  const monthFirst = prefersMonthFirst(hints.currency || hints.baseCurrency);
  const candidates: Array<{ date: string; weight: number }> = [];
  const printed = interpretDate(String(rawPrinted ?? ''), monthFirst);
  printed.forEach((date, i) => candidates.push({ date, weight: printed.length > 1 ? (i === 0 ? 0.75 : 0.5) : 0.95 }));
  for (const date of interpretDate(String(modelDate ?? ''), monthFirst)) {
    if (!candidates.some((c) => c.date === date)) candidates.push({ date, weight: 0.7 });
    else candidates.find((c) => c.date === date)!.weight += 0.1;
  }
  const plausible = candidates.filter((c) => isPlausibleDate(c.date, today));
  if (!plausible.length) {
    return candidates.length
      ? { date: null, confidence: 0, note: `Ignored an impossible date (${candidates[0].date}).` }
      : { date: null, confidence: 0 };
  }
  // Ambiguous dd/mm: if the preferred reading is in the future, the other wins.
  plausible.sort((a, b) => b.weight - a.weight || Math.abs(diffDaysIso(a.date, today)) - Math.abs(diffDaysIso(b.date, today)));
  const best = plausible[0];
  const note =
    candidates.length > plausible.length ? `Date read as ${best.date} (another reading was impossible).` : undefined;
  return { date: best.date, confidence: Math.min(1, best.weight), note };
}

// ---------------------------------------------------------------------------
// Currency, payment method, merchant, description
// ---------------------------------------------------------------------------

export function detectCurrency(
  modelCurrency: unknown,
  evidence: string,
  baseCurrency: string,
): { currency: string; confidence: number } {
  const raw = String(modelCurrency ?? '').trim().toUpperCase();
  if (/^(₹|RS\.?|RUPEES?|INR)$/.test(raw) || raw.includes('RUPEE')) return { currency: 'INR', confidence: 0.95 };
  if (/^[A-Z]{3}$/.test(raw)) return { currency: raw, confidence: 0.9 };
  const hay = evidence.toLowerCase();
  if (/₹|\brs\.?\s?\d|\binr\b|gstin|\bcgst\b|\bsgst\b|\bigst\b|\bupi\b/.test(hay)) return { currency: 'INR', confidence: 0.85 };
  if (/\baed\b|\bdhs?\b|\btrn\b/.test(hay)) return { currency: 'AED', confidence: 0.8 };
  if (/€|\beur\b/.test(hay)) return { currency: 'EUR', confidence: 0.8 };
  if (/£|\bgbp\b/.test(hay)) return { currency: 'GBP', confidence: 0.8 };
  if (raw === '$' || /\$/.test(hay)) {
    const dollar = ['USD', 'AUD', 'CAD', 'SGD', 'NZD', 'HKD'].includes(baseCurrency) ? baseCurrency : 'USD';
    return { currency: dollar, confidence: 0.6 };
  }
  return { currency: baseCurrency, confidence: 0.4 };
}

/** Short, DTO-safe (≤ 32 chars) payment method label. */
export function normalizePaymentMethod(raw: unknown, cardLast4?: string | null): string | null {
  const text = String(raw ?? '').toLowerCase();
  if (!text.trim()) return cardLast4 ? `Card ••${cardLast4}` : null;
  let label: string;
  if (/\bupi\b|gpay|google pay|phonepe|paytm upi|bhim/.test(text)) label = 'UPI';
  else if (/credit/.test(text)) label = 'Credit card';
  else if (/debit/.test(text)) label = 'Debit card';
  else if (/card|visa|master|rupay|amex|swipe|pos/.test(text)) label = 'Card';
  else if (/cash/.test(text)) label = 'Cash';
  else if (/net ?banking|internet banking/.test(text)) label = 'Net banking';
  else if (/neft|imps|rtgs|bank transfer|wire|ach/.test(text)) label = 'Bank transfer';
  else if (/wallet|paytm|amazon pay|mobikwik/.test(text)) label = 'Wallet';
  else if (/cheque|check/.test(text)) label = 'Cheque';
  else label = String(raw).trim().slice(0, 32);
  if (cardLast4 && /card/i.test(label)) label = `${label} ••${cardLast4}`;
  return label.slice(0, 32);
}

const BRAND_MAP: Array<[RegExp, string]> = [
  [/avenue\s+supermarts|\bd[\s-]?mart\b/i, 'DMart'],
  [/bundl\s+technolog|\bswiggy\b/i, 'Swiggy'],
  [/zomato/i, 'Zomato'],
  [/ani\s+technolog|\bola\s*cabs?\b/i, 'Ola'],
  [/uber\s+india|\buber\b/i, 'Uber'],
  [/amazon\s+seller|amazon\.in|\bamazon\b/i, 'Amazon'],
  [/flipkart/i, 'Flipkart'],
  [/blinkit|grofers/i, 'Blinkit'],
  [/zepto|kiranakart/i, 'Zepto'],
  [/supermarket\s+grocery\s+supplies|bigbasket/i, 'BigBasket'],
  [/reliance\s+retail.*smart|reliance\s+smart/i, 'Reliance Smart'],
  [/reliance\s+fresh/i, 'Reliance Fresh'],
  [/indian\s+oil|\biocl\b/i, 'Indian Oil'],
  [/hindustan\s+petroleum|\bhpcl\b/i, 'HP Petrol Pump'],
  [/bharat\s+petroleum|\bbpcl\b/i, 'Bharat Petroleum'],
  [/tata\s+starbucks|starbucks/i, 'Starbucks'],
  [/jubilant\s+foodworks|domino/i, "Domino's"],
  [/hardcastle\s+restaurants|mcdonald/i, "McDonald's"],
  [/devyani\s+international|\bkfc\b/i, 'KFC'],
  [/apollo\s+pharmac/i, 'Apollo Pharmacy'],
  [/medplus/i, 'MedPlus'],
];

export function normalizeMerchantName(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  for (const [re, brand] of BRAND_MAP) if (re.test(text)) return brand;
  const cleaned = cleanMerchant(text);
  return cleaned || null;
}

const DOC_PHRASE: Record<string, string> = {
  grocery: 'Groceries at',
  restaurant: 'Meal at',
  fuel: 'Fuel at',
  pharmacy: 'Medicines from',
  ecommerce: 'Order from',
  travel: 'Travel –',
};

const NOISE_RE = /(gstin|invoice\s*no|bill\s*no|txn|ref\s*no|utr|\b[a-z0-9]{16,}\b|\d{6,})/i;

/** Human description: model's if clean, else built from document type. */
export function buildReceiptDescription(input: {
  modelDescription?: string | null;
  merchant?: string | null;
  documentType?: string | null;
  categoryName?: string | null;
  lineItems?: ReceiptLineItem[];
}): string | null {
  const merchant = input.merchant || null;
  const model = cleanDescription(input.modelDescription || '', 80);
  const letters = model.replace(/[^a-z]/gi, '').length;
  const modelOk =
    model.length >= 3 &&
    letters / Math.max(1, model.length) > 0.55 &&
    !NOISE_RE.test(model) &&
    !(merchant && model.toLowerCase() === merchant.toLowerCase());
  if (modelOk) return model;

  const type = input.documentType || '';
  if (type === 'utility_bill' && merchant) {
    const cat = input.categoryName && !/bill/i.test(input.categoryName) ? `${input.categoryName} bill` : 'Utility bill';
    return cleanDescription(`${cat} – ${merchant}`, 80);
  }
  if (merchant && DOC_PHRASE[type]) return cleanDescription(`${DOC_PHRASE[type]} ${merchant}`, 80);
  if (merchant && input.categoryName && !/^(misc|miscellaneous|other|others)$/i.test(input.categoryName)) {
    return cleanDescription(`${input.categoryName} at ${merchant}`, 80);
  }
  const items = input.lineItems || [];
  if (merchant && items.length === 1) return cleanDescription(`${items[0].name} at ${merchant}`, 80);
  if (merchant) return cleanDescription(`Purchase at ${merchant}`, 80);
  return model || null;
}

/** Map internal status to CreateTransactionDto.payment_status values. */
export function toDtoPaymentStatus(status: string | null | undefined): string | null {
  switch (String(status || '').toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'failed':
      return 'FAILURE';
    case 'pending':
      return 'SUBMITTED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Confidence & second pass
// ---------------------------------------------------------------------------

export function scoreConfidence(input: {
  details: ReceiptDetails;
  reconciliation: ReceiptReconciliation;
  merchant: string | null;
  dateConfidence: number;
  currencyConfidence: number;
  categoryMatched: boolean;
}): ReceiptConfidence {
  const mc = input.details.model_confidence;
  const recon = input.reconciliation;
  const reconFactor =
    recon.status === 'ok' ? 1 : recon.status === 'adjusted' ? 0.85 : recon.status === 'derived' ? 0.7 : recon.status === 'mismatch' ? 0.5 : 0;
  const total = recon.total == null ? 0 : Math.min(1, (mc.total ?? 0.8) * reconFactor + (recon.status === 'ok' ? 0.1 : 0));
  const merchant = input.merchant ? Math.min(1, mc.merchant ?? 0.8) : 0;
  const date = Math.min(input.dateConfidence, mc.date ?? 1);
  const currency = Math.min(input.currencyConfidence, mc.currency ?? 1);
  const category = input.categoryMatched ? Math.min(1, mc.category ?? 0.75) : 0;
  const overall = total * 0.4 + merchant * 0.2 + date * 0.2 + currency * 0.1 + category * 0.1;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { merchant: r(merchant), total: r(total), date: r(date), currency: r(currency), category: r(category), overall: r(overall) };
}

export function secondPassReason(input: {
  reconciliation: ReceiptReconciliation;
  details: ReceiptDetails;
  date: string | null;
  isPayment: boolean;
}): string | null {
  const { reconciliation: recon, details } = input;
  if (recon.status === 'missing') return 'no total could be read';
  if (recon.status === 'mismatch') return recon.notes[recon.notes.length - 1] || 'the totals do not add up';
  if (recon.status === 'adjusted') return recon.notes[0] || 'the total looked like a subtotal or tax line';
  if ((details.model_confidence.total ?? 1) < 0.6) return 'low confidence in the total';
  if (!input.date && !input.isPayment) return 'no valid date could be read';
  return null;
}

/** Overlay a focused totals/date re-read onto the first reading. */
export function mergeTotalsPass(first: ReceiptDetails, second: ReceiptDetails): ReceiptDetails {
  const firstRecon = reconcileTotals(first);
  const merged: ReceiptDetails = {
    ...first,
    subtotal: second.subtotal ?? first.subtotal,
    taxes: second.taxes.length ? second.taxes : first.taxes,
    tax_total: second.tax_total ?? first.tax_total,
    discount_total: second.discount_total ?? first.discount_total,
    tip: second.tip ?? first.tip,
    service_charge: second.service_charge ?? first.service_charge,
    round_off: second.round_off ?? first.round_off,
    grand_total: second.grand_total ?? first.grand_total,
    amount_paid: second.amount_paid ?? first.amount_paid,
    total_label: second.total_label ?? first.total_label,
    date_raw: second.date_raw ?? first.date_raw,
    model_confidence: {
      ...first.model_confidence,
      total: second.model_confidence.total ?? first.model_confidence.total,
      date: second.model_confidence.date ?? first.model_confidence.date,
    },
  };
  const mergedRecon = reconcileTotals(merged);
  const rank = { ok: 4, adjusted: 3, derived: 2, mismatch: 1, missing: 0 } as const;
  // Keep the first reading when the re-read is not strictly better.
  if (rank[mergedRecon.status] < rank[firstRecon.status]) {
    return { ...first, date_raw: merged.date_raw };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export type ReceiptPromptContext = {
  today: string;
  timeZone: string;
  baseCurrency: string;
  userFullName: string | null;
  categoryNames: string[];
  accountLabels: string[];
};

export const RECEIPT_JSON_TEMPLATE = {
  document_type: 'grocery',
  payment_status: 'success',
  transaction_type: 'expense',
  merchant: 'DMart',
  merchant_legal_name: 'Avenue Supermarts Ltd',
  currency: 'INR',
  date_raw: '07/10/26',
  date: '2026-10-07',
  time: '18:42',
  grand_total: 1249.0,
  amount_paid: 1249.0,
  total_label: 'Net Amount',
  subtotal: 1189.52,
  taxes: [{ label: 'CGST 2.5%', rate: 2.5, amount: 29.74 }, { label: 'SGST 2.5%', rate: 2.5, amount: 29.74 }],
  tax_total: 59.48,
  discount_total: null,
  tip: null,
  service_charge: null,
  round_off: 0.0,
  payment_method: 'card',
  card_last4: '4521',
  card_network: 'Visa',
  upi_vpa: null,
  upi_txn_id: null,
  platform: null,
  platform_txn_id: null,
  bank_name: 'HDFC',
  account_last4: '4521',
  account_label: 'HDFC Bank Card XX4521',
  container_name: null,
  destination_bank_name: null,
  destination_account_last4: null,
  destination_account_label: null,
  destination_container_name: null,
  invoice_number: 'B-2231/88',
  merchant_tax_id: '27AACCA8432H1ZQ',
  merchant_address: 'Thane West, Maharashtra',
  notes: null,
  category_name: 'Groceries',
  description: 'Groceries at DMart',
  confidence: { merchant: 0.95, total: 0.95, date: 0.9, currency: 0.99, category: 0.9 },
  line_items: [{ name: 'Toor Dal 1kg', qty: 2, unit_price: 165, amount: 330 }],
};

export function buildReceiptSystemPrompt(ctx: ReceiptPromptContext): string {
  return [
    'You are a meticulous reader of receipts, bills, invoices, fuel slips, utility bills, UPI/GPay/PhonePe/Paytm screenshots and bank transfer confirmations for a personal-finance app.',
    'Return ONE JSON object with exactly the keys of the template below (same order; totals before line items). No prose, no markdown.',
    '',
    'Reading rules',
    '- Copy only what is visible. Unknown or unreadable → null. Never invent merchants, amounts, ids, accounts or dates.',
    '- Amounts are plain numbers (1249.5): no currency symbols, no thousands separators; read decimal commas correctly (12,50 → 12.5).',
    '- grand_total = the final amount payable/paid, labelled e.g. Grand Total, Net Amount, Net Payable, Total Payable, Amount Paid, Bill Amount, Balance Due, Total (INR), or the big "₹…" on a UPI success screen. NEVER use Sub Total, Taxable Value/Amount, Total Qty/Items, MRP total, "You saved", a tax line or a line-item amount as grand_total. Put the label you used in total_label.',
    '- amount_paid = tendered/charged amount if printed separately (card slip, UPI); subtotal = amount before taxes.',
    '- taxes: one entry per printed tax line (CGST, SGST, UTGST, IGST, CESS, VAT, GST, Sales Tax, Service Tax) with rate % and amount; tax_total = their total. discount_total = discounts actually deducted. tip / service_charge if added. round_off is signed (-0.40 or 0.30).',
    `- date_raw exactly as printed; date as YYYY-MM-DD. Numeric dates follow the document's country: India (₹, GSTIN), UK, EU, UAE, most of Asia → DD/MM/YYYY; USA ($ with a US address) → MM/DD/YYYY. Today is ${ctx.today} (${ctx.timeZone}); a receipt is never from the future.`,
    '- time: 24-hour HH:mm exactly as printed (8:39 pm → 20:39). Do not convert timezones.',
    `- currency: ISO 4217 from symbols, words or country (₹ / Rs / INR / GSTIN → INR; AED / TRN → AED; € → EUR; £ → GBP). If nothing indicates it use ${ctx.baseCurrency}.`,
    '- merchant: the brand a person would say ("DMart", not "Avenue Supermarts Ltd"; "Swiggy", not "Bundl Technologies"); merchant_legal_name = registered company if different; merchant_tax_id = GSTIN / VAT / TRN if printed; merchant_address short (area, city).',
    `- document_type: one of ${DOCUMENT_TYPES.join(', ')}.`,
    '- payment_method: cash, card, upi, netbanking, wallet, bank_transfer, cheque or other; card_last4 / card_network / upi_vpa / upi_txn_id when visible.',
    '- description: short and human (≤ 60 chars), e.g. "Groceries at DMart", "Dinner at Truffles", "Electricity bill – BESCOM", "Fuel at Indian Oil". No ids, addresses or OCR noise.',
    '- category_name: EXACTLY one name from the user categories below, chosen from the merchant and items, or null if none fits.',
    '- line_items: at most 25 entries in printed order with short names (name, qty, unit_price, amount); [] for payment screenshots.',
    '- confidence: 0–1 per field for how sure you are it was read correctly.',
    '',
    'Payments, status and transfers',
    '- payment_status: success (Successful/Paid/Completed/Credited), failed (Failed/Declined/Cancelled/Error), pending (Pending/Processing) or null. A printed bill/receipt with a total is success.',
    '- transaction_type: expense (user paid a merchant/person), income (user received money: salary, refund, money received), transfer (money moved between the user\'s OWN accounts: "Paid to self", "Self transfer", NEFT/IMPS between own banks, wallet top-up).',
    userFullName(ctx),
    '- Fill BOTH sides when two accounts are shown: bank_name / account_last4 / account_label = debited ("From", "Paid using"); destination_* = credited ("To", "Credited to"). For a self-transfer merchant is null.',
    '- upi_txn_id = UPI transaction ID / UTR; platform_txn_id = app-specific id (Google transaction ID, PhonePe txn id); platform = Google Pay, PhonePe, Paytm, BHIM, bank app.',
    '- notes: copy the sender\'s Note / Message / Remarks text if visible (it often explains the payment — use it for description and category too), else null. Never put UPI ids, bank names or payee names in notes.',
    '',
    `User accounts (container_name / destination_container_name must be one of these when it matches, else null): ${ctx.accountLabels.slice(0, 40).join(' | ') || '(none)'}`,
    `User categories: ${ctx.categoryNames.slice(0, 120).join(' | ') || '(none)'}`,
    '',
    `JSON template (example values): ${JSON.stringify(RECEIPT_JSON_TEMPLATE)}`,
  ].join('\n');
}

function userFullName(ctx: ReceiptPromptContext): string {
  return ctx.userFullName
    ? `- The app user is "${ctx.userFullName}". If the payee/payer is this person (or clearly the same person), it is a transfer between their own accounts, not an expense.`
    : '- If the payee looks like the same person as the payer (self), use transaction_type transfer.';
}

export const RECEIPT_USER_PROMPT =
  'Read the attached document and return the JSON object now. Totals and date first, then line items. If this is a self / bank-to-bank transfer, set transaction_type to transfer and fill both account sides. If a Note / Message / Remarks line is visible, use it for description and category_name and still copy it into notes.';

export function buildTotalsPassPrompt(first: ReceiptDetails, reason: string): string {
  const reading = {
    grand_total: first.grand_total,
    amount_paid: first.amount_paid,
    subtotal: first.subtotal,
    tax_total: first.tax_total,
    taxes: first.taxes.map((t) => ({ label: t.label, amount: t.amount })),
    discount_total: first.discount_total,
    round_off: first.round_off,
    total_label: first.total_label,
    date_raw: first.date_raw,
  };
  return [
    `Second, focused pass. A first reading gave ${JSON.stringify(reading)} but ${reason}.`,
    'Look ONLY at the totals block at the bottom of the document and at the date/time in the header. Re-read every amount digit by digit.',
    'The grand total is the final payable/paid amount (Grand Total / Net Amount / Total Payable / Amount Paid / Bill Amount). It is NOT the Sub Total, Taxable Value, Total Qty, MRP total, savings, or a single tax line.',
    'Return ONLY this JSON (numbers without symbols, null when not printed):',
    JSON.stringify({
      grand_total: 0,
      amount_paid: null,
      total_label: 'string',
      subtotal: 0,
      taxes: [{ label: 'CGST 2.5%', rate: 2.5, amount: 0 }],
      tax_total: 0,
      discount_total: null,
      tip: null,
      service_charge: null,
      round_off: null,
      currency: 'ISO code',
      date_raw: 'as printed',
      date: 'YYYY-MM-DD',
      time: 'HH:mm',
      confidence: { total: 0.9, date: 0.9 },
    }),
  ].join('\n');
}
