export type ReceiptAccountHint = {
  container_name?: string | null;
  bank_name?: string | null;
  account_last4?: string | null;
  account_label?: string | null;
};

const BANK_ALIASES: Array<{ aliases: string[] }> = [
  { aliases: ['kvb', 'karur vysya', 'karur'] },
  { aliases: ['icici'] },
  { aliases: ['hdfc'] },
  { aliases: ['sbi', 'state bank', 'state bank of india'] },
  { aliases: ['axis'] },
  { aliases: ['kotak'] },
  { aliases: ['yes bank', 'yesbank'] },
  { aliases: ['indusind'] },
  { aliases: ['pnb', 'punjab national'] },
  { aliases: ['bob', 'baroda', 'bank of baroda'] },
  { aliases: ['canara'] },
  { aliases: ['union bank'] },
  { aliases: ['indian bank'] },
  { aliases: ['federal'] },
  { aliases: ['idfc'] },
  { aliases: ['bank of india', 'boi'] },
  { aliases: ['central bank'] },
  { aliases: ['uco'] },
  { aliases: ['rbl'] },
  { aliases: ['au bank', 'au small'] },
  { aliases: ['bandhan'] },
  { aliases: ['hsbc'] },
  { aliases: ['citi'] },
  { aliases: ['standard chartered', 'stanchart'] },
  { aliases: ['paytm payments', 'paytm bank', 'paytm'] },
  { aliases: ['gpay', 'google pay', 'google wallet'] },
  { aliases: ['phonepe'] },
  { aliases: ['amazon pay'] },
];

export function normalizeAccountText(value: string | null | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function last4Digits(value: string | null | undefined): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/** Pull a known bank alias out of a free-form label like "HDFC Bank ••••4521". */
export function inferBankFromLabel(label: string | null | undefined): string | null {
  const hay = normalizeAccountText(label);
  if (!hay) return null;
  for (const group of BANK_ALIASES) {
    if (group.aliases.some((alias) => hay.includes(alias))) {
      return group.aliases[0];
    }
  }
  return null;
}

function hintIsEmpty(hint: ReceiptAccountHint | null | undefined): boolean {
  if (!hint) return true;
  return !(
    hint.container_name ||
    hint.bank_name ||
    hint.account_last4 ||
    hint.account_label
  );
}

export function enrichAccountHint(
  hint: ReceiptAccountHint | null | undefined,
): ReceiptAccountHint | null {
  if (hintIsEmpty(hint)) return null;
  const label = hint!.account_label || hint!.container_name || null;
  const bank =
    hint!.bank_name ||
    inferBankFromLabel(label) ||
    inferBankFromLabel(hint!.container_name);
  const mask =
    last4Digits(hint!.account_last4) ||
    last4Digits(hint!.account_label) ||
    last4Digits(hint!.container_name);
  return {
    container_name: hint!.container_name || null,
    bank_name: bank,
    account_last4: mask,
    account_label: hint!.account_label || null,
  };
}

function scoreContainer<
  T extends { id: string; name: string; type?: string; institution?: string | null },
>(row: T, hint: ReceiptAccountHint): number {
  const wantedName = normalizeAccountText(
    hint.container_name || hint.account_label,
  );
  const bank = normalizeAccountText(
    hint.bank_name || inferBankFromLabel(hint.account_label),
  );
  const mask = (
    hint.account_last4 ||
    last4Digits(hint.account_label) ||
    ''
  ).replace(/\D/g, '');
  const hay = `${normalizeAccountText(row.name)} ${normalizeAccountText(row.institution)}`;
  let score = 0;

  if (wantedName && normalizeAccountText(row.name) === wantedName) score += 100;
  if (wantedName && hay.includes(wantedName) && wantedName.length > 3) {
    score += 40;
  }
  // Partial token overlap for labels like "HDFC 4521" vs container "Salary HDFC"
  if (wantedName) {
    const tokens = wantedName.split(' ').filter((t) => t.length > 2);
    let hits = 0;
    for (const token of tokens) {
      if (hay.includes(token)) hits += 1;
    }
    if (hits >= 2) score += 25;
    else if (hits === 1 && tokens.length === 1) score += 15;
  }

  if (mask.length === 4 && (hay.includes(mask) || last4Digits(row.name) === mask)) {
    score += 80;
  }
  if (bank && hay.includes(bank)) score += 45;

  for (const group of BANK_ALIASES) {
    const bankHit =
      bank && group.aliases.some((alias) => bank.includes(alias));
    const labelHit =
      wantedName && group.aliases.some((alias) => wantedName.includes(alias));
    const rowHit = group.aliases.some((alias) => hay.includes(alias));
    if ((bankHit || labelHit) && rowHit) score += 40;
  }

  // Strong bank + last4 combo is enough even without name match.
  if (mask.length === 4 && bank) {
    const bankOnRow = BANK_ALIASES.some(
      (group) =>
        group.aliases.some((alias) => bank.includes(alias)) &&
        group.aliases.some((alias) => hay.includes(alias)),
    );
    if (bankOnRow && (hay.includes(mask) || last4Digits(row.name) === mask)) {
      score += 30;
    }
  }

  return score;
}

export function matchExpenseSource<
  T extends { id: string; name: string; type?: string; institution?: string | null },
>(
  containers: T[],
  hint: ReceiptAccountHint | null | undefined,
  options?: { excludeIds?: string[]; minScore?: number },
): T | null {
  const enriched = enrichAccountHint(hint);
  if (!enriched || !containers.length) return null;
  const sources = containers.filter((row) => {
    const type = row.type || 'bank';
    return (
      type === 'bank' ||
      type === 'wallet' ||
      type === 'cash' ||
      type === 'credit_card'
    );
  });
  const excluded = new Set(options?.excludeIds || []);
  const pool = (sources.length ? sources : containers).filter(
    (row) => !excluded.has(row.id),
  );
  if (!pool.length) return null;

  let best: T | null = null;
  let bestScore = 0;
  for (const row of pool) {
    const score = scoreContainer(row, enriched);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  const minScore = options?.minScore ?? 40;
  return bestScore >= minScore ? best : null;
}

/**
 * Rank every container against a hint. Useful when both banks appear on a
 * self-transfer receipt and we need a second-best distinct match.
 */
export function rankAccountMatches<
  T extends { id: string; name: string; type?: string; institution?: string | null },
>(
  containers: T[],
  hint: ReceiptAccountHint | null | undefined,
  options?: { excludeIds?: string[]; minScore?: number },
): Array<{ row: T; score: number }> {
  const enriched = enrichAccountHint(hint);
  if (!enriched || !containers.length) return [];
  const excluded = new Set(options?.excludeIds || []);
  const minScore = options?.minScore ?? 40;
  return containers
    .filter((row) => !excluded.has(row.id))
    .map((row) => ({ row, score: scoreContainer(row, enriched) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
