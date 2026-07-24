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
