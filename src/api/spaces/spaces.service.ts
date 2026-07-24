import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { TransactionsService } from '../transactions/transactions.service';
import { can, slugify, type SpacePermission, type SpaceRole } from './spaces.permissions';
import { computeSplits, round2, simplifyDebts } from './spaces.settlement';
import {
  ContributeSpaceGoalDto,
  CreateSettlementDto,
  CreateSpaceBudgetDto,
  CreateSpaceDto,
  CreateSpaceExpenseDto,
  CreateSpaceGoalDto,
  InviteMemberDto,
  SyncOutboxDto,
  UpdateSpaceDto,
  WalletMovementDto,
} from './dto/spaces.dto';

@Injectable()
export class SpacesService {
  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    private readonly transactionsService: TransactionsService,
  ) {}

  async listMine(userId: string) {
    const result = await this.pgPool.query(
      `SELECT s.*, m.role, m.status AS membership_status, m.id AS member_id,
              (f.space_id IS NOT NULL) AS is_favorite, COALESCE(f.position, 9999) AS favorite_position,
              (SELECT COUNT(*)::int FROM space_members sm
                WHERE sm.space_id = s.id AND sm.status = 'active') AS member_count
       FROM collaborative_spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1 AND m.status = 'active'
       LEFT JOIN space_favorites f ON f.space_id = s.id AND f.user_id = $1
       WHERE s.deleted_at IS NULL
       ORDER BY is_favorite DESC, favorite_position ASC, s.updated_at DESC`,
      [userId],
    );
    return result.rows;
  }

  async create(userId: string, dto: CreateSpaceDto) {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const baseSlug = slugify(dto.name);
      let slug = baseSlug;
      for (let i = 0; i < 8; i += 1) {
        const clash = await client.query(
          `SELECT 1 FROM collaborative_spaces WHERE slug = $1`,
          [slug],
        );
        if (!clash.rowCount) break;
        slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;
      }
      const currency = (dto.currency || 'USD').toUpperCase();
      const spaceIns = await client.query(
        `INSERT INTO collaborative_spaces
          (name, slug, description, icon, color, currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          dto.name.trim(),
          slug,
          dto.description?.trim() || null,
          dto.icon || null,
          dto.color || null,
          currency,
          userId,
        ],
      );
      const space = spaceIns.rows[0];
      const wallet = await client.query(
        `INSERT INTO financial_containers
          (user_id, space_id, name, type, balance, currency, include_in_net_worth, notes)
         VALUES ($1,$2,$3,'wallet',0,$4,false,$5)
         RETURNING id`,
        [
          userId,
          space.id,
          'Shared Wallet',
          currency,
          `Wallet for ${dto.name.trim()}`,
        ],
      );
      await client.query(
        `UPDATE collaborative_spaces SET wallet_container_id = $2 WHERE id = $1`,
        [space.id, wallet.rows[0].id],
      );
      const member = await client.query(
        `INSERT INTO space_members (space_id, user_id, role, status, joined_at, display_name)
         VALUES ($1,$2,'owner','active',NOW(),
           (SELECT COALESCE(full_name, email) FROM users WHERE id = $2))
         RETURNING *`,
        [space.id, userId],
      );
      await this.logActivity(client, space.id, userId, 'space_created', 'Space created', {
        name: space.name,
      });
      await client.query('COMMIT');
      return {
        ...space,
        wallet_container_id: wallet.rows[0].id,
        role: 'owner',
        member_id: member.rows[0].id,
        member_count: 1,
        is_favorite: false,
      };
    } catch (error: any) {
      await client.query('ROLLBACK');
      throw new BadRequestException(error.message || 'Could not create space');
    } finally {
      client.release();
    }
  }

  async getDashboard(userId: string, spaceId: string) {
    const membership = await this.requireMembership(userId, spaceId, 'read');
    const [space, members, balances, expenses, settlements, budgets, goals, activity, wallet] =
      await Promise.all([
        this.findSpace(spaceId),
        this.listMembers(spaceId),
        this.computeBalances(spaceId),
        this.pgPool.query(
          `SELECT COALESCE(SUM(amount),0)::float AS total
           FROM space_expenses WHERE space_id = $1 AND deleted_at IS NULL`,
          [spaceId],
        ),
        this.listSettlements(spaceId),
        this.listBudgets(spaceId),
        this.listGoals(spaceId),
        this.listActivity(spaceId, 20),
        this.pgPool.query(
          `SELECT id, name, balance, currency FROM financial_containers
           WHERE id = (SELECT wallet_container_id FROM collaborative_spaces WHERE id = $1)`,
          [spaceId],
        ),
      ]);

    const mine = balances.find((b) => b.member_id === membership.id);
    const youOwe = mine && mine.net < 0 ? Math.abs(mine.net) : 0;
    const youAreOwed = mine && mine.net > 0 ? mine.net : 0;
    const outstanding = balances.reduce((s, b) => s + Math.max(0, b.net), 0);
    const budgetTotal = budgets.reduce((s: number, b: any) => s + Number(b.amount || 0), 0);
    const budgetSpent = budgets.reduce((s: number, b: any) => s + Number(b.spent || 0), 0);
    const favorite = await this.pgPool.query(
      `SELECT 1 FROM space_favorites WHERE user_id = $1 AND space_id = $2`,
      [userId, spaceId],
    );

    return {
      space: { ...space, is_favorite: Boolean(favorite.rowCount) },
      membership,
      members,
      balances,
      suggested_settlements: simplifyDebts(
        balances.map((b) => ({ memberId: b.member_id, net: b.net })),
      ),
      metrics: {
        total_spent: Number(expenses.rows[0]?.total || 0),
        total_budget: budgetTotal,
        budget_spent: budgetSpent,
        outstanding_settlements: round2(outstanding),
        you_owe: round2(youOwe),
        you_are_owed: round2(youAreOwed),
        shared_wallet_balance: Number(wallet.rows[0]?.balance || 0),
        wallet: wallet.rows[0] || null,
      },
      budgets,
      goals,
      recent_settlements: settlements.slice(0, 10),
      activity,
      ai_summary: this.buildAiSummary({
        spaceName: space.name,
        totalSpent: Number(expenses.rows[0]?.total || 0),
        youOwe: round2(youOwe),
        youAreOwed: round2(youAreOwed),
        memberCount: members.length,
        currency: space.currency,
      }),
    };
  }

  async updateSpace(userId: string, spaceId: string, dto: UpdateSpaceDto) {
    await this.requireMembership(userId, spaceId, 'manage_space');
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const key of ['name', 'description', 'icon', 'color', 'currency'] as const) {
      if (dto[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(typeof dto[key] === 'string' ? String(dto[key]).trim() : dto[key]);
      }
    }
    if (!fields.length) throw new BadRequestException('No updates provided');
    values.push(spaceId);
    const result = await this.pgPool.query(
      `UPDATE collaborative_spaces SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!result.rowCount) throw new NotFoundException('Space not found');
    await this.logActivity(this.pgPool, spaceId, userId, 'space_updated', 'Space settings updated');
    return result.rows[0];
  }

  async setFavorite(userId: string, spaceId: string, favorite: boolean, position = 0) {
    await this.requireMembership(userId, spaceId, 'read');
    if (favorite) {
      await this.pgPool.query(
        `INSERT INTO space_favorites (user_id, space_id, position)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, space_id) DO UPDATE SET position = EXCLUDED.position`,
        [userId, spaceId, position],
      );
    } else {
      await this.pgPool.query(
        `DELETE FROM space_favorites WHERE user_id = $1 AND space_id = $2`,
        [userId, spaceId],
      );
    }
    return { favorite };
  }

  async listMembers(spaceId: string) {
    const result = await this.pgPool.query(
      `SELECT m.*, u.email, u.full_name, u.avatar_url
       FROM space_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.space_id = $1 AND m.status = 'active'
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                m.joined_at ASC NULLS LAST`,
      [spaceId],
    );
    return result.rows;
  }

  async invite(userId: string, spaceId: string, dto: InviteMemberDto) {
    await this.requireMembership(userId, spaceId, 'manage_members');
    const email = dto.email.trim().toLowerCase();
    const role = dto.role || 'member';
    const space = await this.findSpace(spaceId);

    const existingUser = await this.pgPool.query(
      `SELECT id, full_name FROM users WHERE lower(email) = $1`,
      [email],
    );
    if (existingUser.rowCount) {
      const uid = existingUser.rows[0].id;
      const activeMember = await this.pgPool.query(
        `SELECT id FROM space_members
         WHERE space_id = $1 AND user_id = $2 AND status = 'active'`,
        [spaceId, uid],
      );
      if (activeMember.rowCount) {
        throw new BadRequestException('User is already a member');
      }
    }

    const pending = await this.pgPool.query(
      `SELECT * FROM space_invites
       WHERE space_id = $1 AND lower(email) = $2
         AND revoked_at IS NULL AND accepted_at IS NULL
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [spaceId, email],
    );

    let token: string;
    let expires: Date;
    let inviteId: string;

    if (pending.rowCount) {
      token = pending.rows[0].token;
      expires = new Date(pending.rows[0].expires_at);
      inviteId = pending.rows[0].id;
      await this.pgPool.query(
        `UPDATE space_invites
         SET role = $2, invited_by = $3, expires_at = $4
         WHERE id = $1`,
        [
          inviteId,
          role,
          userId,
          new Date(Date.now() + 7 * 86400000).toISOString(),
        ],
      );
      expires = new Date(Date.now() + 7 * 86400000);
    } else {
      token = randomBytes(24).toString('hex');
      expires = new Date(Date.now() + 7 * 86400000);
      const inserted = await this.pgPool.query(
        `INSERT INTO space_invites (space_id, email, role, token, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [spaceId, email, role, token, userId, expires.toISOString()],
      );
      inviteId = inserted.rows[0].id;
    }

    const acceptHref = `/spaces/invites/${token}`;

    // In-app inbox only — no email delivery while mail is disabled.
    if (existingUser.rowCount) {
      await this.notify(
        existingUser.rows[0].id,
        spaceId,
        'invite',
        `Invite to ${space.name}`,
        acceptHref,
        `You were invited to join “${space.name}” as ${role}. Open this notification to accept.`,
      );
    }

    await this.logActivity(
      this.pgPool,
      spaceId,
      userId,
      'member_invited',
      `Invited ${email}`,
      { email, role, invite_id: inviteId, delivered_in_app: Boolean(existingUser.rowCount) },
    );

    return {
      invited: true,
      email,
      role,
      token,
      expires_at: expires.toISOString(),
      delivered_in_app: Boolean(existingUser.rowCount),
      accept_path: acceptHref,
    };
  }

  async acceptInvite(userId: string, token: string) {
    const invite = await this.pgPool.query(
      `SELECT * FROM space_invites
       WHERE token = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [token],
    );
    if (!invite.rowCount) throw new NotFoundException('Invite not found');
    const row = invite.rows[0];
    if (new Date(row.expires_at) < new Date()) {
      throw new BadRequestException('Invite expired');
    }
    const user = await this.pgPool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (user.rows[0].email.toLowerCase() !== row.email.toLowerCase()) {
      throw new ForbiddenException('Invite email does not match your account');
    }
    await this.pgPool.query(
      `INSERT INTO space_members (space_id, user_id, role, status, joined_at, display_name)
       VALUES ($1,$2,$3,'active',NOW(),
         (SELECT COALESCE(full_name, email) FROM users WHERE id = $2))
       ON CONFLICT (space_id, user_id) DO UPDATE
         SET status = 'active', role = EXCLUDED.role, joined_at = NOW(), updated_at = NOW()`,
      [row.space_id, userId, row.role],
    );
    await this.pgPool.query(
      `UPDATE space_invites SET accepted_at = NOW() WHERE id = $1`,
      [row.id],
    );
    await this.logActivity(this.pgPool, row.space_id, userId, 'invite_accepted', 'Invite accepted');
    await this.notify(
      userId,
      row.space_id,
      'invite_accepted',
      'You joined a space',
      `/spaces/${row.space_id}`,
      'Invite accepted — you are now a member.',
    );
    return { space_id: row.space_id };
  }

  async updateMemberRole(
    userId: string,
    spaceId: string,
    memberId: string,
    role: SpaceRole,
  ) {
    const actor = await this.requireMembership(userId, spaceId, 'manage_members');
    const target = await this.pgPool.query(
      `SELECT * FROM space_members WHERE id = $1 AND space_id = $2 AND status = 'active'`,
      [memberId, spaceId],
    );
    if (!target.rowCount) throw new NotFoundException('Member not found');
    if (target.rows[0].role === 'owner' && actor.role !== 'owner') {
      throw new ForbiddenException('Only the owner can change the owner role');
    }
    if (role === 'owner') {
      if (actor.role !== 'owner') throw new ForbiddenException('Only owner can transfer ownership');
      await this.pgPool.query(
        `UPDATE space_members SET role = 'admin', updated_at = NOW()
         WHERE space_id = $1 AND role = 'owner'`,
        [spaceId],
      );
    }
    await this.pgPool.query(
      `UPDATE space_members SET role = $2, updated_at = NOW() WHERE id = $1`,
      [memberId, role],
    );
    await this.logActivity(this.pgPool, spaceId, userId, 'role_changed', 'Member role updated', {
      memberId,
      role,
    });
    return this.listMembers(spaceId);
  }

  async removeMember(userId: string, spaceId: string, memberId: string) {
    const target = await this.pgPool.query(
      `SELECT * FROM space_members WHERE id = $1 AND space_id = $2 AND status = 'active'`,
      [memberId, spaceId],
    );
    if (!target.rowCount) throw new NotFoundException('Member not found');

    const isSelf = target.rows[0].user_id === userId;
    if (isSelf) {
      await this.requireMembership(userId, spaceId, 'read');
      if (target.rows[0].role === 'owner') {
        throw new BadRequestException(
          'Transfer ownership before leaving this space',
        );
      }
      await this.pgPool.query(
        `UPDATE space_members SET status = 'left', updated_at = NOW() WHERE id = $1`,
        [memberId],
      );
      await this.logActivity(this.pgPool, spaceId, userId, 'member_left', 'Left the space', {
        memberId,
      });
      return { left: true };
    }

    await this.requireMembership(userId, spaceId, 'manage_members');
    if (target.rows[0].role === 'owner') {
      throw new BadRequestException('Transfer ownership before removing the owner');
    }
    await this.pgPool.query(
      `UPDATE space_members SET status = 'removed', updated_at = NOW() WHERE id = $1`,
      [memberId],
    );
    await this.logActivity(this.pgPool, spaceId, userId, 'member_removed', 'Member removed', {
      memberId,
    });
    return { removed: true };
  }

  async createExpense(userId: string, spaceId: string, dto: CreateSpaceExpenseDto) {
    const membership = await this.requireMembership(userId, spaceId, 'add_expense');
    const space = await this.findSpace(spaceId);
    const splits = computeSplits(dto.split_method, dto.amount, dto.participants);
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const expense = await client.query(
        `INSERT INTO space_expenses
          (space_id, title, amount, currency, payer_member_id, split_method, category,
           expense_date, notes, tags, receipt_name, receipt_mime_type, receipt_base64,
           created_by, link_to_personal, personal_container_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          spaceId,
          dto.title.trim(),
          dto.amount,
          space.currency,
          dto.payer_member_id,
          dto.split_method,
          dto.category || null,
          dto.expense_date || new Date().toISOString().slice(0, 10),
          dto.notes || null,
          JSON.stringify(dto.tags || []),
          dto.receipt_name || null,
          dto.receipt_mime_type || null,
          dto.receipt_base64 || null,
          userId,
          dto.link_to_personal === true,
          dto.personal_container_id || null,
        ],
      );
      const expenseId = expense.rows[0].id;
      for (const split of splits) {
        await client.query(
          `INSERT INTO space_expense_splits (expense_id, member_id, share_value, owed_amount)
           VALUES ($1,$2,$3,$4)`,
          [expenseId, split.member_id, split.share_value, split.owed_amount],
        );
      }

      let personalTxId: string | null = null;
      if (dto.link_to_personal && dto.personal_container_id) {
        const mySplit = splits.find((s) => s.member_id === membership.id);
        const amount = mySplit?.owed_amount || 0;
        if (amount > 0) {
          const tx = await this.transactionsService.create(userId, {
            type: 'expense',
            amount,
            description: `[${space.name}] ${dto.title.trim()}`,
            date: dto.expense_date || new Date().toISOString().slice(0, 10),
            source_container_id: dto.personal_container_id,
            currency: space.currency,
            notes: dto.notes || `Linked space expense ${expenseId}`,
            merchant: dto.title.trim(),
          } as any);
          personalTxId = tx.id;
          await client.query(
            `UPDATE space_expenses SET personal_transaction_id = $2 WHERE id = $1`,
            [expenseId, personalTxId],
          );
        }
      }

      await this.logActivity(client, spaceId, userId, 'expense_added', dto.title.trim(), {
        expense_id: expenseId,
        amount: dto.amount,
      });
      await client.query('COMMIT');
      return this.getExpense(spaceId, expenseId);
    } catch (error: any) {
      await client.query('ROLLBACK');
      throw new BadRequestException(error.message || 'Could not create expense');
    } finally {
      client.release();
    }
  }

  async listExpenses(spaceId: string) {
    const result = await this.pgPool.query(
      `SELECT e.*,
              json_agg(json_build_object(
                'id', s.id,
                'member_id', s.member_id,
                'share_value', s.share_value,
                'owed_amount', s.owed_amount
              ) ORDER BY s.owed_amount DESC) AS splits
       FROM space_expenses e
       LEFT JOIN space_expense_splits s ON s.expense_id = e.id
       WHERE e.space_id = $1 AND e.deleted_at IS NULL
       GROUP BY e.id
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      [spaceId],
    );
    return result.rows.map((row) => ({
      ...row,
      amount: Number(row.amount),
      splits: Array.isArray(row.splits)
        ? row.splits.filter((s: any) => s && s.member_id)
        : [],
    }));
  }

  async getExpense(spaceId: string, expenseId: string) {
    const rows = await this.listExpenses(spaceId);
    const found = rows.find((r) => r.id === expenseId);
    if (!found) throw new NotFoundException('Expense not found');
    return found;
  }

  async computeBalances(spaceId: string) {
    const members = await this.listMembers(spaceId);
    const nets = new Map<string, number>();
    for (const m of members) nets.set(m.id, 0);

    const expenses = await this.pgPool.query(
      `SELECT e.payer_member_id, s.member_id, s.owed_amount
       FROM space_expenses e
       JOIN space_expense_splits s ON s.expense_id = e.id
       WHERE e.space_id = $1 AND e.deleted_at IS NULL`,
      [spaceId],
    );
    for (const row of expenses.rows) {
      const owed = Number(row.owed_amount);
      nets.set(row.member_id, round2((nets.get(row.member_id) || 0) - owed));
      nets.set(
        row.payer_member_id,
        round2((nets.get(row.payer_member_id) || 0) + owed),
      );
    }

    const settlements = await this.pgPool.query(
      `SELECT from_member_id, to_member_id, amount
       FROM space_settlements
       WHERE space_id = $1 AND deleted_at IS NULL AND status = 'completed'`,
      [spaceId],
    );
    for (const row of settlements.rows) {
      const amount = Number(row.amount);
      nets.set(
        row.from_member_id,
        round2((nets.get(row.from_member_id) || 0) + amount),
      );
      nets.set(
        row.to_member_id,
        round2((nets.get(row.to_member_id) || 0) - amount),
      );
    }

    return members.map((m) => ({
      member_id: m.id,
      user_id: m.user_id,
      display_name: m.display_name || m.full_name || m.email,
      email: m.email,
      avatar_url: m.avatar_url,
      role: m.role,
      net: nets.get(m.id) || 0,
    }));
  }

  async createSettlement(userId: string, spaceId: string, dto: CreateSettlementDto) {
    await this.requireMembership(userId, spaceId, 'settle');
    const space = await this.findSpace(spaceId);
    if (dto.from_member_id === dto.to_member_id) {
      throw new BadRequestException('Cannot settle with yourself');
    }
    const status = dto.scheduled_at ? 'scheduled' : 'completed';
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO space_settlements
          (space_id, from_member_id, to_member_id, amount, currency, status, notes,
           proof_name, proof_mime_type, proof_base64, scheduled_at, settled_at,
           created_by, link_to_personal, personal_container_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          spaceId,
          dto.from_member_id,
          dto.to_member_id,
          dto.amount,
          space.currency,
          status,
          dto.notes || null,
          dto.proof_name || null,
          dto.proof_mime_type || null,
          dto.proof_base64 || null,
          dto.scheduled_at || null,
          status === 'completed' ? new Date().toISOString() : null,
          userId,
          dto.link_to_personal === true,
          dto.personal_container_id || null,
        ],
      );
      let personalTxId: string | null = null;
      if (dto.link_to_personal && dto.personal_container_id && status === 'completed') {
        const tx = await this.transactionsService.create(userId, {
          type: 'expense',
          amount: dto.amount,
          description: `[${space.name}] Settlement`,
          date: new Date().toISOString().slice(0, 10),
          source_container_id: dto.personal_container_id,
          currency: space.currency,
          notes: dto.notes || `Space settlement ${result.rows[0].id}`,
        } as any);
        personalTxId = tx.id;
        await client.query(
          `UPDATE space_settlements SET personal_transaction_id = $2 WHERE id = $1`,
          [result.rows[0].id, personalTxId],
        );
      }
      await this.logActivity(client, spaceId, userId, 'settlement_completed', 'Settlement recorded', {
        settlement_id: result.rows[0].id,
        amount: dto.amount,
      });
      await client.query('COMMIT');
      return { ...result.rows[0], personal_transaction_id: personalTxId };
    } catch (error: any) {
      await client.query('ROLLBACK');
      throw new BadRequestException(error.message || 'Could not create settlement');
    } finally {
      client.release();
    }
  }

  async listSettlements(spaceId: string) {
    const result = await this.pgPool.query(
      `SELECT * FROM space_settlements
       WHERE space_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [spaceId],
    );
    return result.rows.map((r) => ({ ...r, amount: Number(r.amount) }));
  }

  async createBudget(userId: string, spaceId: string, dto: CreateSpaceBudgetDto) {
    await this.requireMembership(userId, spaceId, 'manage_budgets');
    const space = await this.findSpace(spaceId);
    const result = await this.pgPool.query(
      `INSERT INTO space_budgets
        (space_id, name, amount, currency, period_type, category, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        spaceId,
        dto.name.trim(),
        dto.amount,
        space.currency,
        dto.period_type || 'monthly',
        dto.category || null,
        dto.notes || null,
        userId,
      ],
    );
    await this.logActivity(this.pgPool, spaceId, userId, 'budget_changed', 'Budget created', {
      budget_id: result.rows[0].id,
    });
    return result.rows[0];
  }

  async listBudgets(spaceId: string) {
    const space = await this.findSpace(spaceId);
    const budgets = await this.pgPool.query(
      `SELECT * FROM space_budgets WHERE space_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [spaceId],
    );
    const spentByCategory = await this.pgPool.query(
      `SELECT COALESCE(category, '') AS category, COALESCE(SUM(amount),0)::float AS spent
       FROM space_expenses
       WHERE space_id = $1 AND deleted_at IS NULL
         AND expense_date >= date_trunc('month', CURRENT_DATE)::date
       GROUP BY 1`,
      [spaceId],
    );
    const map = new Map(
      spentByCategory.rows.map((r) => [r.category || '', Number(r.spent)]),
    );
    return budgets.rows.map((b) => {
      const spent = b.category
        ? map.get(b.category) || 0
        : Number(
            spentByCategory.rows.reduce((s, r) => s + Number(r.spent), 0),
          );
      return {
        ...b,
        amount: Number(b.amount),
        spent: round2(spent),
        remaining: round2(Number(b.amount) - spent),
        currency: b.currency || space.currency,
      };
    });
  }

  async createGoal(userId: string, spaceId: string, dto: CreateSpaceGoalDto) {
    await this.requireMembership(userId, spaceId, 'manage_goals');
    const space = await this.findSpace(spaceId);
    const result = await this.pgPool.query(
      `INSERT INTO space_goals
        (space_id, name, target_amount, current_amount, currency, target_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        spaceId,
        dto.name.trim(),
        dto.target_amount,
        dto.current_amount || 0,
        space.currency,
        dto.target_date || null,
        dto.notes || null,
        userId,
      ],
    );
    await this.logActivity(this.pgPool, spaceId, userId, 'goal_updated', 'Goal created', {
      goal_id: result.rows[0].id,
    });
    return result.rows[0];
  }

  async contributeGoal(
    userId: string,
    spaceId: string,
    goalId: string,
    dto: ContributeSpaceGoalDto,
  ) {
    const membership = await this.requireMembership(userId, spaceId, 'add_expense');
    const goal = await this.pgPool.query(
      `SELECT * FROM space_goals WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [goalId, spaceId],
    );
    if (!goal.rowCount) throw new NotFoundException('Goal not found');
    await this.pgPool.query(
      `INSERT INTO space_goal_contributions (goal_id, member_id, amount, note)
       VALUES ($1,$2,$3,$4)`,
      [goalId, membership.id, dto.amount, dto.note || null],
    );
    const updated = await this.pgPool.query(
      `UPDATE space_goals
       SET current_amount = current_amount + $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [goalId, dto.amount],
    );
    await this.logActivity(this.pgPool, spaceId, userId, 'goal_updated', 'Goal contribution', {
      goal_id: goalId,
      amount: dto.amount,
    });
    return updated.rows[0];
  }

  async listGoals(spaceId: string) {
    const result = await this.pgPool.query(
      `SELECT * FROM space_goals WHERE space_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [spaceId],
    );
    return result.rows.map((g) => ({
      ...g,
      target_amount: Number(g.target_amount),
      current_amount: Number(g.current_amount),
      progress_percent:
        Number(g.target_amount) > 0
          ? round2((Number(g.current_amount) / Number(g.target_amount)) * 100)
          : 0,
    }));
  }

  async listActivity(spaceId: string, limit = 50) {
    const result = await this.pgPool.query(
      `SELECT a.*, u.full_name AS actor_name, u.email AS actor_email
       FROM space_activity a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.space_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [spaceId, limit],
    );
    return result.rows;
  }

  async walletMove(userId: string, spaceId: string, dto: WalletMovementDto) {
    await this.requireMembership(userId, spaceId, 'settle');
    const space = await this.findSpace(spaceId);
    if (!space.wallet_container_id) {
      throw new BadRequestException('Space wallet is not configured');
    }
    const delta = dto.kind === 'deposit' ? dto.amount : -dto.amount;
    const result = await this.pgPool.query(
      `UPDATE financial_containers
       SET balance = balance + $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, balance, currency`,
      [space.wallet_container_id, delta],
    );
    await this.logActivity(
      this.pgPool,
      spaceId,
      userId,
      dto.kind === 'deposit' ? 'wallet_deposit' : 'wallet_withdrawal',
      `Wallet ${dto.kind}`,
      { amount: dto.amount, note: dto.note },
    );
    return result.rows[0];
  }

  async reports(userId: string, spaceId: string) {
    await this.requireMembership(userId, spaceId, 'read');
    const [byMember, byCategory, settlements, balances] = await Promise.all([
      this.pgPool.query(
        `SELECT s.member_id, m.display_name, COALESCE(SUM(s.owed_amount),0)::float AS spent
         FROM space_expense_splits s
         JOIN space_expenses e ON e.id = s.expense_id AND e.deleted_at IS NULL
         JOIN space_members m ON m.id = s.member_id
         WHERE e.space_id = $1
         GROUP BY s.member_id, m.display_name
         ORDER BY spent DESC`,
        [spaceId],
      ),
      this.pgPool.query(
        `SELECT COALESCE(category, 'Uncategorized') AS category,
                COALESCE(SUM(amount),0)::float AS spent,
                COUNT(*)::int AS count
         FROM space_expenses
         WHERE space_id = $1 AND deleted_at IS NULL
         GROUP BY 1 ORDER BY spent DESC`,
        [spaceId],
      ),
      this.listSettlements(spaceId),
      this.computeBalances(spaceId),
    ]);
    return {
      spend_by_member: byMember.rows,
      spend_by_category: byCategory.rows,
      settlements,
      balances,
      suggested_settlements: simplifyDebts(
        balances.map((b) => ({ memberId: b.member_id, net: b.net })),
      ),
    };
  }

  async enqueueSync(userId: string, dto: SyncOutboxDto) {
    const result = await this.pgPool.query(
      `INSERT INTO space_sync_outbox (user_id, space_id, client_op_id, entity_type, payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, client_op_id) DO UPDATE
         SET payload = EXCLUDED.payload, status = 'pending', error = NULL
       RETURNING *`,
      [
        userId,
        dto.space_id || null,
        dto.client_op_id,
        dto.entity_type,
        JSON.stringify(dto.payload || {}),
      ],
    );
    return result.rows[0];
  }

  async listSyncOutbox(userId: string) {
    const result = await this.pgPool.query(
      `SELECT * FROM space_sync_outbox
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 100`,
      [userId],
    );
    return result.rows;
  }

  async markSynced(userId: string, ids: string[]) {
    if (!ids.length) return { updated: 0 };
    const result = await this.pgPool.query(
      `UPDATE space_sync_outbox
       SET status = 'synced', synced_at = NOW()
       WHERE user_id = $1 AND id = ANY($2::uuid[])
       RETURNING id`,
      [userId, ids],
    );
    return { updated: result.rowCount };
  }

  async listNotifications(userId: string) {
    const user = await this.pgPool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const email = String(user.rows[0]?.email || '').toLowerCase();

    const notices = await this.pgPool.query(
      `SELECT n.*, s.name AS space_name
       FROM space_notifications n
       LEFT JOIN collaborative_spaces s ON s.id = n.space_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [userId],
    );

    // Also surface pending invites by email (inbox), even if a notify row was missed.
    const invites = email
      ? await this.pgPool.query(
          `SELECT i.id, i.token, i.role, i.expires_at, i.created_at, i.space_id,
                  s.name AS space_name
           FROM space_invites i
           JOIN collaborative_spaces s ON s.id = i.space_id
           WHERE lower(i.email) = $1
             AND i.revoked_at IS NULL
             AND i.accepted_at IS NULL
             AND i.expires_at > NOW()
           ORDER BY i.created_at DESC
           LIMIT 20`,
          [email],
        )
      : { rows: [] as any[] };

    const inviteNotices = invites.rows.map((row) => ({
      id: `invite-${row.id}`,
      user_id: userId,
      space_id: row.space_id,
      kind: 'invite',
      title: `Invite to ${row.space_name}`,
      body: `You were invited as ${row.role}. Accept to join this Collaborative Space.`,
      href: `/spaces/invites/${row.token}`,
      read_at: null,
      created_at: row.created_at,
      space_name: row.space_name,
    }));

    const seenHrefs = new Set(inviteNotices.map((n) => n.href));
    const merged = [
      ...inviteNotices,
      ...notices.rows.filter(
        (n) => !(n.kind === 'invite' && n.href && seenHrefs.has(n.href)),
      ),
    ].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    return merged.slice(0, 50);
  }

  async overviewForAi(userId: string) {
    const spaces = await this.listMine(userId);
    const summaries: Array<{
      id: string;
      name: string;
      role: string;
      currency: string;
      member_count: number;
      you_owe: number;
      you_are_owed: number;
    }> = [];
    for (const space of spaces.slice(0, 8)) {
      const balances = await this.computeBalances(space.id);
      const mine = balances.find((b) => b.user_id === userId);
      summaries.push({
        id: space.id,
        name: space.name,
        role: space.role,
        currency: space.currency,
        member_count: Number(space.member_count || 0),
        you_owe: mine && mine.net < 0 ? Math.abs(mine.net) : 0,
        you_are_owed: mine && mine.net > 0 ? mine.net : 0,
      });
    }
    return summaries;
  }

  async assertReadable(userId: string, spaceId: string) {
    return this.requireMembership(userId, spaceId, 'read');
  }

  private async findSpace(spaceId: string) {
    const result = await this.pgPool.query(
      `SELECT * FROM collaborative_spaces WHERE id = $1 AND deleted_at IS NULL`,
      [spaceId],
    );
    if (!result.rowCount) throw new NotFoundException('Space not found');
    return result.rows[0];
  }

  private async requireMembership(
    userId: string,
    spaceId: string,
    permission: SpacePermission,
  ) {
    const result = await this.pgPool.query(
      `SELECT * FROM space_members
       WHERE space_id = $1 AND user_id = $2 AND status = 'active'`,
      [spaceId, userId],
    );
    if (!result.rowCount) throw new ForbiddenException('Not a member of this space');
    const membership = result.rows[0];
    if (!can(membership.role as SpaceRole, permission)) {
      throw new ForbiddenException('Insufficient space permissions');
    }
    return membership;
  }

  private async logActivity(
    db: Pool | { query: Pool['query'] },
    spaceId: string,
    actorUserId: string | null,
    eventType: string,
    title: string,
    payload: Record<string, unknown> = {},
  ) {
    await db.query(
      `INSERT INTO space_activity (space_id, actor_user_id, event_type, title, summary, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        spaceId,
        actorUserId,
        eventType,
        title,
        title,
        JSON.stringify(payload),
      ],
    );
  }

  private async notify(
    userId: string,
    spaceId: string,
    kind: string,
    title: string,
    href?: string,
    body?: string,
  ) {
    await this.pgPool.query(
      `INSERT INTO space_notifications (user_id, space_id, kind, title, body, href)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, spaceId, kind, title, body || null, href || null],
    );
  }

  private buildAiSummary(input: {
    spaceName: string;
    totalSpent: number;
    youOwe: number;
    youAreOwed: number;
    memberCount: number;
    currency: string;
  }) {
    const parts = [
      `${input.spaceName} has ${input.memberCount} active members.`,
      `Recorded spend totals ${round2(input.totalSpent)} ${input.currency}.`,
    ];
    if (input.youOwe > 0) {
      parts.push(`You currently owe ${input.youOwe} ${input.currency}.`);
    } else if (input.youAreOwed > 0) {
      parts.push(`Others owe you ${input.youAreOwed} ${input.currency}.`);
    } else {
      parts.push('Your balances look settled.');
    }
    return parts.join(' ');
  }
}
