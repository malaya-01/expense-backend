import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Pool } from 'pg';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CategoriesService } from '../categories/categories.service';
import { BudgetsService } from '../budgets/budgets.service';
import { GoalsService } from '../goals/goals.service';
import { InvestmentsService } from '../investments/investments.service';
import { LoansService } from '../loans/loans.service';
import { RecurringService } from '../recurring/recurring.service';
import { UserService } from '../user/user.service';
import { AiAdvisorService } from '../ai-advisor/ai-advisor.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  SYNC_ENTITY_MODULE,
  syncOpToCrud,
  crudPerm,
  permissionSatisfied,
} from '../permissions/permission.codes';
import {
  SyncChangeDto,
  SyncEntityType,
  SyncPushDto,
} from './dto/sync.dto';

const FINANCIAL_TYPES = new Set<SyncEntityType>([
  'account',
  'transaction',
  'category',
  'budget',
  'goal',
  'investment',
  'loan',
  'recurring',
]);

const TABLE_BY_TYPE: Partial<
  Record<SyncEntityType, { table: string; idColumn?: string }>
> = {
  account: { table: 'financial_containers' },
  transaction: { table: 'ledger_transactions' },
  category: { table: 'categories' },
  budget: { table: 'budgets' },
  goal: { table: 'goals' },
  investment: { table: 'investment_holdings' },
  loan: { table: 'loans' },
  recurring: { table: 'recurring_schedules' },
  user_settings: { table: 'users', idColumn: 'id' },
  ai_preferences: { table: 'user_ai_preferences', idColumn: 'user_id' },
  ai_memory: { table: 'ai_memories' },
  notification_preferences: {
    table: 'user_notification_preferences',
    idColumn: 'user_id',
  },
};

export type SyncOpResult = {
  client_op_id: string;
  status: 'applied' | 'conflict' | 'error' | 'duplicate';
  server_row?: Record<string, unknown> | null;
  error?: string;
};

@Injectable()
export class SyncService {
  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
    private readonly categories: CategoriesService,
    private readonly budgets: BudgetsService,
    private readonly goals: GoalsService,
    private readonly investments: InvestmentsService,
    private readonly loans: LoansService,
    private readonly recurring: RecurringService,
    private readonly users: UserService,
    private readonly aiAdvisor: AiAdvisorService,
    private readonly permissions: PermissionsService,
  ) {}

  private async assertEntityPermission(
    userId: string,
    entityType: string,
    op = 'read',
  ) {
    const module = SYNC_ENTITY_MODULE[entityType];
    if (!module) return;
    const action = syncOpToCrud(op);
    const required = crudPerm(module, action);
    const access = await this.permissions.resolveEffectiveAccess(userId);
    if (access.is_admin) return;
    // Authenticated product users may sync their own records.
    if (permissionSatisfied(access.permissions, `${module}.access`)) return;
    if (!permissionSatisfied(access.permissions, required)) {
      throw new BadRequestException(
        `Permission denied for sync ${op} on ${entityType} (need ${required})`,
      );
    }
  }

  private async allowedEntityTypes(userId: string): Promise<Set<string>> {
    const access = await this.permissions.resolveEffectiveAccess(userId);
    if (access.is_admin) {
      return new Set(Object.keys(SYNC_ENTITY_MODULE));
    }
    const allowed = new Set<string>();
    for (const [entity, module] of Object.entries(SYNC_ENTITY_MODULE)) {
      if (permissionSatisfied(access.permissions, crudPerm(module, 'read'))) {
        allowed.add(entity);
      }
    }
    return allowed;
  }

  async status(userId: string) {
    const pending = await this.pgPool.query(
      `SELECT COUNT(*)::int AS count FROM sync_client_ops
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
      [userId],
    );
    return {
      server_time: new Date().toISOString(),
      recent_ops: pending.rows[0]?.count ?? 0,
    };
  }

  async push(userId: string, dto: SyncPushDto): Promise<{ results: SyncOpResult[] }> {
    const results: SyncOpResult[] = [];
    for (const change of dto.changes) {
      const existing = await this.pgPool.query(
        `SELECT status, result_json FROM sync_client_ops
         WHERE user_id = $1 AND client_op_id = $2`,
        [userId, change.client_op_id],
      );
      if (existing.rowCount) {
        results.push({
          client_op_id: change.client_op_id,
          status: 'duplicate',
          server_row: existing.rows[0].result_json?.server_row ?? null,
        });
        continue;
      }

      try {
        await this.assertEntityPermission(
          userId,
          change.entity_type,
          change.op,
        );
        const conflict = await this.detectConflict(userId, change);
        if (conflict) {
          const result: SyncOpResult = {
            client_op_id: change.client_op_id,
            status: 'conflict',
            server_row: conflict,
          };
          await this.recordOp(userId, change, result);
          results.push(result);
          continue;
        }

        const serverRow = await this.applyChange(userId, change);
        const result: SyncOpResult = {
          client_op_id: change.client_op_id,
          status: 'applied',
          server_row: serverRow as Record<string, unknown>,
        };
        await this.recordOp(userId, change, result);
        results.push(result);
      } catch (error: any) {
        const result: SyncOpResult = {
          client_op_id: change.client_op_id,
          status: 'error',
          error: error?.message || 'Failed to apply change',
        };
        await this.recordOp(userId, change, result);
        results.push(result);
      }
    }

    await this.pgPool.query(
      `INSERT INTO user_sync_state (user_id, device_id, pull_cursor, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET updated_at = NOW()`,
      [userId, dto.device_id],
    );

    return { results };
  }

  async pull(userId: string, since: string | undefined, deviceId: string) {
    const cursor = since ? new Date(since) : new Date(0);
    if (Number.isNaN(cursor.getTime())) {
      throw new BadRequestException('Invalid since cursor');
    }

    const allowed = await this.allowedEntityTypes(userId);
    const empty = { rows: [] as Record<string, unknown>[] };

    const [
      accounts,
      transactions,
      categories,
      budgets,
      goals,
      investments,
      loans,
      recurring,
      userSettings,
      aiPreferences,
      aiMemories,
      notificationPreferences,
    ] = await Promise.all([
      allowed.has('account')
        ? this.pullTable(userId, 'financial_containers', cursor)
        : empty,
      allowed.has('transaction')
        ? this.pullTable(userId, 'ledger_transactions', cursor)
        : empty,
      allowed.has('category')
        ? this.pullTable(userId, 'categories', cursor)
        : empty,
      allowed.has('budget')
        ? this.pullTable(userId, 'budgets', cursor)
        : empty,
      allowed.has('goal')
        ? this.pullTable(userId, 'goals', cursor)
        : empty,
      allowed.has('investment')
        ? this.pullTable(userId, 'investment_holdings', cursor)
        : empty,
      allowed.has('loan')
        ? this.pullTable(userId, 'loans', cursor)
        : empty,
      allowed.has('recurring')
        ? this.pullTable(userId, 'recurring_schedules', cursor)
        : empty,
      allowed.has('user_settings')
        ? this.pgPool.query(
            `SELECT id, email, full_name, country, currency, timezone, locale,
                    avatar_url, sync_version, created_at, updated_at, deleted_at
             FROM users
             WHERE id = $1 AND updated_at > $2`,
            [userId, cursor],
          )
        : empty,
      allowed.has('ai_preferences')
        ? this.pgPool.query(
            `SELECT user_id, active_provider, active_model, master_prompt,
                    memory_enabled, sync_version, created_at, updated_at
             FROM user_ai_preferences
             WHERE user_id = $1 AND updated_at > $2`,
            [userId, cursor],
          )
        : empty,
      allowed.has('ai_memory')
        ? this.pgPool.query(
            `SELECT id, user_id, content, source, sync_version,
                    created_at, updated_at, deleted_at
             FROM ai_memories
             WHERE user_id = $1 AND updated_at > $2`,
            [userId, cursor],
          )
        : empty,
      allowed.has('notification_preferences')
        ? this.pgPool.query(
            `SELECT user_id, preferences, sync_version, created_at, updated_at, deleted_at
             FROM user_notification_preferences
             WHERE user_id = $1 AND updated_at > $2`,
            [userId, cursor],
          )
        : empty,
    ]);

    const serverTime = new Date();
    await this.pgPool.query(
      `INSERT INTO user_sync_state (user_id, device_id, pull_cursor, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET pull_cursor = EXCLUDED.pull_cursor, updated_at = NOW()`,
      [userId, deviceId || 'unknown', serverTime.toISOString()],
    );

    return {
      cursor: serverTime.toISOString(),
      server_time: serverTime.toISOString(),
      changes: {
        accounts: accounts.rows,
        transactions: transactions.rows,
        categories: categories.rows,
        budgets: budgets.rows,
        goals: goals.rows,
        investments: investments.rows,
        loans: loans.rows,
        recurring: recurring.rows,
        user_settings: userSettings.rows,
        ai_preferences: aiPreferences.rows,
        ai_memories: aiMemories.rows,
        notification_preferences: notificationPreferences.rows,
      },
    };
  }

  private async pullTable(userId: string, table: string, cursor: Date) {
    return this.pgPool.query(
      `SELECT * FROM ${table}
       WHERE user_id = $1 AND updated_at > $2
       ORDER BY updated_at ASC`,
      [userId, cursor],
    );
  }

  private async detectConflict(userId: string, change: SyncChangeDto) {
    if (change.force) return null;
    if (!FINANCIAL_TYPES.has(change.entity_type)) return null;
    if (change.op === 'create') return null;
    if (change.base_sync_version == null || !change.entity_id) return null;

    const meta = TABLE_BY_TYPE[change.entity_type];
    if (!meta) return null;

    const idCol = meta.idColumn || 'id';
    const result = await this.pgPool.query(
      `SELECT * FROM ${meta.table}
       WHERE ${idCol} = $1 AND user_id = $2`,
      [change.entity_id, userId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (Number(row.sync_version) !== Number(change.base_sync_version)) {
      return row;
    }
    return null;
  }

  private async recordOp(
    userId: string,
    change: SyncChangeDto,
    result: SyncOpResult,
  ) {
    await this.pgPool.query(
      `INSERT INTO sync_client_ops
        (user_id, client_op_id, entity_type, entity_id, op, status, result_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, client_op_id) DO NOTHING`,
      [
        userId,
        change.client_op_id,
        change.entity_type,
        change.entity_id || null,
        change.op,
        result.status === 'duplicate' ? 'applied' : result.status,
        JSON.stringify(result),
      ],
    );
  }

  private async applyChange(userId: string, change: SyncChangeDto) {
    const payload = {
      ...(change.payload || {}),
      ...(change.entity_id ? { id: change.entity_id } : {}),
    } as any;

    switch (change.entity_type) {
      case 'account':
        if (change.op === 'create') return this.accounts.create(userId, payload);
        if (change.op === 'update')
          return this.accounts.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.accounts.remove(userId, change.entity_id!);
        break;
      case 'transaction':
        if (change.op === 'create')
          return this.transactions.create(userId, payload);
        if (change.op === 'update')
          return this.transactions.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.transactions.remove(userId, change.entity_id!);
        break;
      case 'category':
        if (change.op === 'create')
          return this.categories.create(userId, payload);
        if (change.op === 'update')
          return this.categories.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.categories.remove(userId, change.entity_id!);
        break;
      case 'budget':
        if (change.op === 'create') return this.budgets.create(userId, payload);
        if (change.op === 'update')
          return this.budgets.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.budgets.remove(userId, change.entity_id!);
        break;
      case 'goal':
        if (change.op === 'create') return this.goals.create(userId, payload);
        if (change.op === 'update')
          return this.goals.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.goals.remove(userId, change.entity_id!);
        break;
      case 'goal_contribute':
        return this.goals.contribute(userId, change.entity_id!, payload);
      case 'investment':
        if (change.op === 'create')
          return this.investments.create(userId, payload);
        if (change.op === 'update')
          return this.investments.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.investments.remove(userId, change.entity_id!);
        break;
      case 'loan':
        if (change.op === 'create') return this.loans.create(userId, payload);
        if (change.op === 'update')
          return this.loans.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.loans.archive(userId, change.entity_id!);
        break;
      case 'loan_payment':
        return this.loans.recordPayment(userId, change.entity_id!, payload);
      case 'recurring':
        if (change.op === 'create')
          return this.recurring.create(userId, payload);
        if (change.op === 'update')
          return this.recurring.update(userId, change.entity_id!, payload);
        if (change.op === 'delete')
          return this.recurring.archive(userId, change.entity_id!);
        break;
      case 'recurring_execute':
        return this.recurring.execute(userId, change.entity_id!);
      case 'user_settings':
        return this.users.updateProfile(userId, payload);
      case 'ai_preferences':
        return this.upsertAiPreferences(userId, payload);
      case 'ai_memory':
        if (change.op === 'create')
          return this.createAiMemory(userId, payload);
        if (change.op === 'delete') {
          const soft = await this.pgPool.query(
            `UPDATE ai_memories
             SET deleted_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
             RETURNING id, deleted_at`,
            [change.entity_id, userId],
          );
          if (!soft.rowCount) {
            return this.aiAdvisor.deleteMemory(userId, change.entity_id!);
          }
          return soft.rows[0];
        }
        break;
      case 'notification_preferences':
        return this.upsertNotificationPreferences(userId, payload);
      default:
        break;
    }
    throw new BadRequestException(
      `Unsupported sync op ${change.op} for ${change.entity_type}`,
    );
  }

  private async upsertAiPreferences(
    userId: string,
    payload: Record<string, unknown>,
  ) {
    const memoryEnabled =
      payload.memory_enabled === undefined
        ? null
        : Boolean(payload.memory_enabled);
    const masterPrompt =
      payload.master_prompt === undefined
        ? null
        : (payload.master_prompt as string | null);
    const activeProvider =
      payload.active_provider === undefined
        ? null
        : (payload.active_provider as string | null);
    const activeModel =
      payload.active_model === undefined
        ? null
        : (payload.active_model as string | null);

    const result = await this.pgPool.query(
      `INSERT INTO user_ai_preferences
        (user_id, active_provider, active_model, master_prompt, memory_enabled, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         active_provider = COALESCE($2, user_ai_preferences.active_provider),
         active_model = COALESCE($3, user_ai_preferences.active_model),
         master_prompt = COALESCE($4, user_ai_preferences.master_prompt),
         memory_enabled = COALESCE($5, user_ai_preferences.memory_enabled),
         updated_at = NOW()
       RETURNING user_id, active_provider, active_model, master_prompt,
                 memory_enabled, sync_version, created_at, updated_at`,
      [userId, activeProvider, activeModel, masterPrompt, memoryEnabled],
    );
    return result.rows[0];
  }

  private async createAiMemory(
    userId: string,
    payload: { id?: string; content: string; source?: string },
  ) {
    const content = String(payload.content || '').trim();
    if (!content) throw new BadRequestException('Memory content is required');
    if (payload.id) {
      const result = await this.pgPool.query(
        `INSERT INTO ai_memories (id, user_id, content, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           updated_at = NOW(),
           deleted_at = NULL
         RETURNING id, user_id, content, source, sync_version, created_at, updated_at, deleted_at`,
        [payload.id, userId, content, payload.source || 'user'],
      );
      return result.rows[0];
    }
    return this.aiAdvisor.addMemory(userId, content);
  }

  private async upsertNotificationPreferences(
    userId: string,
    payload: { preferences?: Record<string, unknown> },
  ) {
    const incoming = (payload.preferences ?? payload) as Record<string, unknown>;
    const existing = await this.pgPool.query(
      `SELECT preferences FROM user_notification_preferences
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const current =
      existing.rows[0]?.preferences &&
      typeof existing.rows[0].preferences === 'object'
        ? (existing.rows[0].preferences as Record<string, unknown>)
        : {};
    const currentIds = Array.isArray(current.dismissed_ids)
      ? current.dismissed_ids.map(String)
      : [];
    const incomingIds = Array.isArray(incoming.dismissed_ids)
      ? incoming.dismissed_ids.map(String)
      : [];
    const prefs = {
      ...current,
      ...incoming,
      dismissed_ids: [...new Set([...currentIds, ...incomingIds])],
    };
    const result = await this.pgPool.query(
      `INSERT INTO user_notification_preferences (user_id, preferences, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         preferences = EXCLUDED.preferences,
         updated_at = NOW(),
         deleted_at = NULL
       RETURNING user_id, preferences, sync_version, created_at, updated_at, deleted_at`,
      [userId, JSON.stringify(prefs)],
    );
    return result.rows[0];
  }
}
