import {
  applyExpenseNets,
  applySettlementNet,
  computeItemizedSplits,
  computeSplits,
  maxSettlementAmount,
  normalizePayers,
  simplifyDebts,
} from './spaces.settlement';

function netsOf(
  events: Array<
    | { kind: 'expense'; payers: { member_id: string; paid_amount: number }[]; shares: { member_id: string; owed_amount: number }[] }
    | { kind: 'settle'; from: string; to: string; amount: number }
  >,
) {
  const nets = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'expense') {
      applyExpenseNets(nets, event.payers, event.shares);
    } else {
      applySettlementNet(nets, event.from, event.to, event.amount);
    }
  }
  return nets;
}

describe('space splitwise ledger', () => {
  it('splits a dinner the payer covered and clears it when the others settle', () => {
    const shares = computeSplits('equal', 3000, [
      { member_id: 'a' },
      { member_id: 'b' },
      { member_id: 'c' },
    ]);
    expect(shares.map((s) => s.owed_amount)).toEqual([1000, 1000, 1000]);
    const afterBill = netsOf([
      {
        kind: 'expense',
        payers: [{ member_id: 'a', paid_amount: 3000 }],
        shares,
      },
    ]);
    expect(afterBill.get('a')).toBe(2000);
    expect(afterBill.get('b')).toBe(-1000);
    expect(afterBill.get('c')).toBe(-1000);

    const plan = simplifyDebts(
      [...afterBill.entries()].map(([memberId, net]) => ({ memberId, net })),
    );
    expect(plan).toEqual([
      { from_member_id: 'b', to_member_id: 'a', amount: 1000 },
      { from_member_id: 'c', to_member_id: 'a', amount: 1000 },
    ]);

    const settled = netsOf([
      {
        kind: 'expense',
        payers: [{ member_id: 'a', paid_amount: 3000 }],
        shares,
      },
      { kind: 'settle', from: 'b', to: 'a', amount: 1000 },
      { kind: 'settle', from: 'c', to: 'a', amount: 1000 },
    ]);
    expect(settled.get('a')).toBe(0);
    expect(settled.get('b')).toBe(0);
    expect(settled.get('c')).toBe(0);
  });

  it('nets later bills the way a running group does', () => {
    const groceries = computeSplits('equal', 3000, [
      { member_id: 'alice' },
      { member_id: 'bob' },
      { member_id: 'charlie' },
    ]);
    const taxi = computeSplits('exact', 1200, [
      { member_id: 'alice', share_value: 600 },
      { member_id: 'bob', share_value: 600 },
    ]);
    const dinner = computeSplits('equal', 900, [
      { member_id: 'alice' },
      { member_id: 'bob' },
      { member_id: 'charlie' },
    ]);
    const nets = netsOf([
      { kind: 'expense', payers: [{ member_id: 'alice', paid_amount: 3000 }], shares: groceries },
      { kind: 'expense', payers: [{ member_id: 'bob', paid_amount: 1200 }], shares: taxi },
      { kind: 'expense', payers: [{ member_id: 'charlie', paid_amount: 900 }], shares: dinner },
    ]);
    expect(nets.get('alice')).toBe(1100);
    expect(nets.get('bob')).toBe(-700);
    expect(nets.get('charlie')).toBe(-400);
    expect(
      simplifyDebts(
        [...nets.entries()].map(([memberId, net]) => ({ memberId, net })),
      ),
    ).toEqual([
      { from_member_id: 'bob', to_member_id: 'alice', amount: 700 },
      { from_member_id: 'charlie', to_member_id: 'alice', amount: 400 },
    ]);
  });

  it('keeps a payer who did not join the meal', () => {
    const shares = computeSplits('equal', 3000, [
      { member_id: 'b' },
      { member_id: 'c' },
    ]);
    const nets = netsOf([
      {
        kind: 'expense',
        payers: [{ member_id: 'a', paid_amount: 3000 }],
        shares,
      },
    ]);
    expect(nets.get('a')).toBe(3000);
    expect(nets.get('b')).toBe(-1500);
    expect(nets.get('c')).toBe(-1500);
  });

  it('reconciles awkward equal splits to the exact total', () => {
    const shares = computeSplits('equal', 1000, [
      { member_id: 'a' },
      { member_id: 'b' },
      { member_id: 'c' },
    ]);
    expect(shares.map((s) => s.owed_amount)).toEqual([333.34, 333.33, 333.33]);
    expect(shares.reduce((s, r) => s + r.owed_amount, 0)).toBeCloseTo(1000, 2);
  });

  it('assigns receipt lines, including a shared line', () => {
    const shares = computeItemizedSplits(1000, [
      { name: 'Alice meal', amount: 400, member_ids: ['alice'] },
      { name: 'Bob meal', amount: 300, member_ids: ['bob'] },
      { name: 'Dessert', amount: 300, member_ids: ['alice', 'bob'] },
    ]);
    const byId = Object.fromEntries(shares.map((s) => [s.member_id, s.owed_amount]));
    expect(byId.alice).toBe(550);
    expect(byId.bob).toBe(450);
  });

  it('requires multiple payers to cover the bill', () => {
    expect(
      normalizePayers(6000, 'alice', [
        { member_id: 'alice', paid_amount: 4000 },
        { member_id: 'bob', paid_amount: 2000 },
      ]),
    ).toEqual([
      { member_id: 'alice', paid_amount: 4000 },
      { member_id: 'bob', paid_amount: 2000 },
    ]);
    expect(() =>
      normalizePayers(6000, 'alice', [
        { member_id: 'alice', paid_amount: 4000 },
        { member_id: 'bob', paid_amount: 1000 },
      ]),
    ).toThrow(/add up to 6000/);
  });

  it('refuses a settlement larger than the open debt', () => {
    const balances = [
      { memberId: 'a', net: 2000 },
      { memberId: 'b', net: -1000 },
      { memberId: 'c', net: -1000 },
    ];
    expect(maxSettlementAmount(balances, 'b', 'a')).toBe(1000);
    expect(maxSettlementAmount(balances, 'a', 'b')).toBe(0);
    expect(maxSettlementAmount(balances, 'b', 'c')).toBe(0);
  });
});
