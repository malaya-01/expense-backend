export type NetBalance = { memberId: string; net: number };

export type SuggestedTransfer = {
  from_member_id: string;
  to_member_id: string;
  amount: number;
};

/** Greedy debt simplification: minimize number of transfers. */
export function simplifyDebts(balances: NetBalance[]): SuggestedTransfer[] {
  const debtors = balances
    .filter((b) => b.net < -0.005)
    .map((b) => ({ memberId: b.memberId, amount: Math.abs(round2(b.net)) }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = balances
    .filter((b) => b.net > 0.005)
    .map((b) => ({ memberId: b.memberId, amount: round2(b.net) }))
    .sort((a, b) => b.amount - a.amount);

  const transfers: SuggestedTransfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay >= 0.01) {
      transfers.push({
        from_member_id: debtors[i].memberId,
        to_member_id: creditors[j].memberId,
        amount: round2(pay),
      });
    }
    debtors[i].amount = round2(debtors[i].amount - pay);
    creditors[j].amount = round2(creditors[j].amount - pay);
    if (debtors[i].amount < 0.01) i += 1;
    if (creditors[j].amount < 0.01) j += 1;
  }
  return transfers;
}

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type PayerInput = { member_id: string; paid_amount: number };

/** One payer covers the whole bill unless explicit contributions are given. */
export function normalizePayers(
  total: number,
  payerMemberId: string | undefined,
  payers?: PayerInput[],
): PayerInput[] {
  const amount = round2(total);
  if (payers && payers.length) {
    const rows = payers.map((p) => ({
      member_id: p.member_id,
      paid_amount: round2(Number(p.paid_amount || 0)),
    }));
    if (rows.some((r) => !(r.paid_amount > 0))) {
      throw new Error('Each person who paid must have a positive amount');
    }
    if (new Set(rows.map((r) => r.member_id)).size !== rows.length) {
      throw new Error('Each payer can only be listed once');
    }
    const sum = round2(rows.reduce((s, r) => s + r.paid_amount, 0));
    if (Math.abs(sum - amount) > 0.02) {
      throw new Error(`Amounts paid must add up to ${amount} (got ${sum})`);
    }
    return rows.sort((a, b) => b.paid_amount - a.paid_amount);
  }
  if (!payerMemberId) throw new Error('Choose who paid');
  return [{ member_id: payerMemberId, paid_amount: amount }];
}

export type LineItemInput = {
  name?: string;
  amount: number;
  member_ids: string[];
};

/**
 * Assign each receipt line to the people on that line.
 * A shared line is split equally in minor units so the lines still sum to the bill.
 */
export function computeItemizedSplits(
  total: number,
  items: LineItemInput[],
): Array<{ member_id: string; share_value: number; owed_amount: number }> {
  if (!items.length) throw new Error('Add at least one line from the bill');
  const centsByMember = new Map<string, number>();
  let itemCents = 0;
  for (const item of items) {
    const cents = Math.round(round2(Number(item.amount)) * 100);
    if (cents <= 0) throw new Error('Each line must be greater than zero');
    const members = Array.from(new Set(item.member_ids || []));
    if (!members.length) throw new Error('Each line needs at least one person');
    itemCents += cents;
    const base = Math.floor(cents / members.length);
    let remainder = cents - base * members.length;
    for (const memberId of members) {
      const part = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      centsByMember.set(memberId, (centsByMember.get(memberId) || 0) + part);
    }
  }
  const totalCents = Math.round(round2(total) * 100);
  if (itemCents !== totalCents) {
    throw new Error(
      `Line items must add up to ${round2(totalCents / 100)} (got ${round2(itemCents / 100)})`,
    );
  }
  return Array.from(centsByMember.entries()).map(([member_id, cents]) => ({
    member_id,
    share_value: round2(cents / 100),
    owed_amount: round2(cents / 100),
  }));
}

/** Paid increases the net; the person's own share decreases it. */
export function applyExpenseNets(
  nets: Map<string, number>,
  payers: PayerInput[],
  shares: Array<{ member_id: string; owed_amount: number }>,
) {
  for (const payer of payers) {
    const paid = round2(Number(payer.paid_amount));
    nets.set(
      payer.member_id,
      round2((nets.get(payer.member_id) || 0) + paid),
    );
  }
  for (const share of shares) {
    const owed = round2(Number(share.owed_amount));
    nets.set(
      share.member_id,
      round2((nets.get(share.member_id) || 0) - owed),
    );
  }
}

export function applySettlementNet(
  nets: Map<string, number>,
  fromMemberId: string,
  toMemberId: string,
  amount: number,
) {
  const value = round2(amount);
  nets.set(fromMemberId, round2((nets.get(fromMemberId) || 0) + value));
  nets.set(toMemberId, round2((nets.get(toMemberId) || 0) - value));
}

/**
 * A repayment cannot exceed what the debtor still owes in this space,
 * nor what the creditor is still owed. Partial payments are allowed.
 */
export function maxSettlementAmount(
  balances: NetBalance[],
  fromMemberId: string,
  toMemberId: string,
): number {
  const from = balances.find((b) => b.memberId === fromMemberId)?.net ?? 0;
  const to = balances.find((b) => b.memberId === toMemberId)?.net ?? 0;
  const debtorOwes = from < -0.005 ? round2(Math.abs(from)) : 0;
  const creditorOwed = to > 0.005 ? round2(to) : 0;
  return round2(Math.min(debtorOwes, creditorOwed));
}

export type SplitInput = {
  member_id: string;
  share_value?: number;
};

export function computeSplits(
  method: 'equal' | 'exact' | 'percentage' | 'shares',
  total: number,
  participants: SplitInput[],
): Array<{ member_id: string; share_value: number | null; owed_amount: number }> {
  if (!participants.length) {
    throw new Error('At least one participant is required');
  }
  const amount = round2(total);
  if (amount <= 0) throw new Error('Amount must be positive');

  if (method === 'equal') {
    const base = Math.floor((amount * 100) / participants.length) / 100;
    const rows = participants.map((p) => ({
      member_id: p.member_id,
      share_value: 1,
      owed_amount: base,
    }));
    let remainder = round2(amount - base * participants.length);
    let idx = 0;
    while (remainder >= 0.01 && idx < rows.length) {
      rows[idx].owed_amount = round2(rows[idx].owed_amount + 0.01);
      remainder = round2(remainder - 0.01);
      idx += 1;
    }
    return rows;
  }

  if (method === 'exact') {
    const rows = participants.map((p) => ({
      member_id: p.member_id,
      share_value: Number(p.share_value || 0),
      owed_amount: round2(Number(p.share_value || 0)),
    }));
    const sum = round2(rows.reduce((s, r) => s + r.owed_amount, 0));
    if (Math.abs(sum - amount) > 0.02) {
      throw new Error(`Exact split amounts must sum to ${amount} (got ${sum})`);
    }
    return rows;
  }

  if (method === 'percentage') {
    const pctSum = participants.reduce((s, p) => s + Number(p.share_value || 0), 0);
    if (Math.abs(pctSum - 100) > 0.05) {
      throw new Error('Percentages must sum to 100');
    }
    const rows = participants.map((p) => {
      const pct = Number(p.share_value || 0);
      return {
        member_id: p.member_id,
        share_value: pct,
        owed_amount: round2((amount * pct) / 100),
      };
    });
    const sum = round2(rows.reduce((s, r) => s + r.owed_amount, 0));
    const drift = round2(amount - sum);
    if (rows.length && Math.abs(drift) >= 0.01) {
      rows[0].owed_amount = round2(rows[0].owed_amount + drift);
    }
    return rows;
  }

  // shares
  const shareTotal = participants.reduce((s, p) => s + Number(p.share_value || 0), 0);
  if (shareTotal <= 0) throw new Error('Shares must be positive');
  const rows = participants.map((p) => {
    const shares = Number(p.share_value || 0);
    return {
      member_id: p.member_id,
      share_value: shares,
      owed_amount: round2((amount * shares) / shareTotal),
    };
  });
  const sum = round2(rows.reduce((s, r) => s + r.owed_amount, 0));
  const drift = round2(amount - sum);
  if (rows.length && Math.abs(drift) >= 0.01) {
    rows[0].owed_amount = round2(rows[0].owed_amount + drift);
  }
  return rows;
}
