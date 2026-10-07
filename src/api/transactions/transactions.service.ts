import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import {
  convertAmount,
  getRate,
  roundMoney,
} from 'src/common/currency/currency.data';
import { requireDateOnly } from 'src/common/date/to-date-only';
import { ObjectStorageService } from 'src/storage/object-storage.service';

const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'payable']);

type ContainerRow = {
  id: string;
  type: string;
  balance: string | number;
  currency: string;
};

type ReceiptContext = Pick<PostedTx, 'date' | 'merchant' | 'description'> | null;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PostedTx = {
  type: 'expense' | 'income' | 'transfer';
  amount: number;
  currency: string;
  source_container_id?: string | null;
  destination_container_id?: string | null;
  source_currency?: string | null;
  destination_currency?: string | null;
  exchange_rate: number;
  fx_rate_to_base: number;
  amount_base: number;
  description: string;
  date: string;
  category_id?: string | null;
  merchant?: string | null;
  notes?: string | null;
};

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    private readonly storage: ObjectStorageService,
  ) {}

  async create(userId: string, dto: CreateTransactionDto) {
    this.validateShape(dto);
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const created = await this.createWithClient(client, userId, dto);
      await client.query('COMMIT');
      return created;
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.status) throw error;
      throw new BadRequestException(
        error.message || 'Failed to create transaction',
      );
    } finally {
      client.release();
    }
  }

  /**
   * Create a ledger transaction using an already-open pool client/transaction.
   * Callers must BEGIN/COMMIT/ROLLBACK and release the client themselves.
   * Avoids nested `pgPool.connect()` deadlocks when composing multi-step writes.
   */
  async createWithClient(
    client: PoolClient,
    userId: string,
    dto: CreateTransactionDto,
    sourceModule = 'transactions',
  ) {
    this.validateShape(dto);
    const posted = await this.buildPostedTx(client, userId, dto);
    const clientId = (dto as { id?: string }).id;
    const result = await client.query(
      clientId
        ? `INSERT INTO ledger_transactions
            (id, user_id, type, amount, description, date, category_id,
             source_container_id, destination_container_id, merchant, currency, notes,
             exchange_rate, fx_rate_to_base, amount_base,
             payment_method, upi_vpa, upi_txn_id, payment_status, paid_at,
             platform, platform_txn_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
           RETURNING *`
        : `INSERT INTO ledger_transactions
            (user_id, type, amount, description, date, category_id,
             source_container_id, destination_container_id, merchant, currency, notes,
             exchange_rate, fx_rate_to_base, amount_base,
             payment_method, upi_vpa, upi_txn_id, payment_status, paid_at,
             platform, platform_txn_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING *`,
      clientId
        ? [
            clientId,
            userId,
            posted.type,
            posted.amount,
            posted.description,
            posted.date,
            posted.category_id || null,
            posted.source_container_id || null,
            posted.destination_container_id || null,
            posted.merchant || null,
            posted.currency,
            posted.notes || null,
            posted.exchange_rate,
            posted.fx_rate_to_base,
            posted.amount_base,
            dto.payment_method || null,
            dto.upi_vpa || null,
            dto.upi_txn_id || null,
            dto.payment_status || null,
            dto.paid_at || null,
            dto.platform || null,
            dto.platform_txn_id || null,
          ]
        : [
            userId,
            posted.type,
            posted.amount,
            posted.description,
            posted.date,
            posted.category_id || null,
            posted.source_container_id || null,
            posted.destination_container_id || null,
            posted.merchant || null,
            posted.currency,
            posted.notes || null,
            posted.exchange_rate,
            posted.fx_rate_to_base,
            posted.amount_base,
            dto.payment_method || null,
            dto.upi_vpa || null,
            dto.upi_txn_id || null,
            dto.payment_status || null,
            dto.paid_at || null,
            dto.platform || null,
            dto.platform_txn_id || null,
          ],
    );
    await this.postJournal(
      client,
      userId,
      result.rows[0].id,
      posted,
      sourceModule,
    );
    const withReceipt = await this.attachReceipt(
      client,
      userId,
      result.rows[0].id,
      dto.receipt_id,
      posted,
    );
    return this.normalize(withReceipt || result.rows[0]);
  }

  async findAll(userId: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `SELECT t.*,
                sc.name AS source_name,
                sc.currency AS source_currency,
                dc.name AS destination_name,
                dc.currency AS destination_currency,
                c.name AS category_name
         FROM ledger_transactions t
         LEFT JOIN financial_containers sc ON sc.id = t.source_container_id
         LEFT JOIN financial_containers dc ON dc.id = t.destination_container_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1 AND t.deleted_at IS NULL
         ORDER BY t.date DESC, t.created_at DESC`,
        [userId],
      );
      return result.rows.map((row) => this.normalize(row));
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to fetch transactions',
      );
    } finally {
      client.release();
    }
  }

  async findOne(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `SELECT t.*,
                sc.name AS source_name,
                sc.currency AS source_currency,
                dc.name AS destination_name,
                dc.currency AS destination_currency,
                c.name AS category_name
         FROM ledger_transactions t
         LEFT JOIN financial_containers sc ON sc.id = t.source_container_id
         LEFT JOIN financial_containers dc ON dc.id = t.destination_container_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
        [userId, id],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Transaction not found');
      }
      return this.normalize(result.rows[0]);
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to fetch transaction',
      );
    } finally {
      client.release();
    }
  }

  async findJournal(userId: string, transactionId: string) {
    const transaction = await this.pgPool.query(
      `SELECT id FROM ledger_transactions
       WHERE id = $1 AND user_id = $2`,
      [transactionId, userId],
    );
    if (!transaction.rowCount) {
      throw new NotFoundException('Transaction not found');
    }

    const result = await this.pgPool.query(
      `SELECT
         j.id,
         j.transaction_id,
         j.reversal_of_journal_id,
         j.description,
         j.source_module,
         j.correlation_id,
         j.status,
         j.posted_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id', l.id,
               'sequence_number', l.sequence_number,
               'container_id', l.container_id,
               'container_name', c.name,
               'account_code', l.account_code,
               'debit_base', l.debit_base,
               'credit_base', l.credit_base,
               'native_amount', l.native_amount,
               'currency', l.currency,
               'metadata', l.metadata
             )
             ORDER BY l.sequence_number
           ) FILTER (WHERE l.id IS NOT NULL),
           '[]'::json
         ) AS lines
       FROM ledger_journals j
       LEFT JOIN ledger_journal_lines l ON l.journal_id = j.id
       LEFT JOIN financial_containers c ON c.id = l.container_id
       WHERE j.user_id = $1 AND j.transaction_id = $2
       GROUP BY j.id
       ORDER BY j.created_at DESC`,
      [userId, transactionId],
    );

    return result.rows.map((journal) => ({
      ...journal,
      lines: (journal.lines || []).map((line: Record<string, unknown>) => ({
        ...line,
        debit_base: Number(line.debit_base || 0),
        credit_base: Number(line.credit_base || 0),
        native_amount: Number(line.native_amount || 0),
      })),
    }));
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM ledger_transactions
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [userId, id],
      );
      if (!existing.rowCount) {
        throw new NotFoundException('Transaction not found');
      }
      const currentRow = existing.rows[0];
      const currentPosted: PostedTx = {
        type: currentRow.type,
        amount: Number(currentRow.amount),
        currency: currentRow.currency,
        source_container_id: currentRow.source_container_id,
        destination_container_id: currentRow.destination_container_id,
        exchange_rate: Number(currentRow.exchange_rate || 1),
        fx_rate_to_base: Number(currentRow.fx_rate_to_base || 1),
        amount_base: Number(currentRow.amount_base || currentRow.amount),
        description: currentRow.description,
        date: requireDateOnly(currentRow.date),
        category_id: currentRow.category_id,
        merchant: currentRow.merchant,
        notes: currentRow.notes,
      };

      // When the posting's containers/type change, the stored currency and
      // exchange rate no longer apply; let buildPostedTx derive them again.
      const containersChanged =
        (dto.type !== undefined && dto.type !== currentPosted.type) ||
        (dto.source_container_id !== undefined &&
          dto.source_container_id !== currentPosted.source_container_id) ||
        (dto.destination_container_id !== undefined &&
          dto.destination_container_id !==
            currentPosted.destination_container_id);

      const merged: CreateTransactionDto = {
        type: dto.type ?? currentPosted.type,
        amount: dto.amount ?? currentPosted.amount,
        description: dto.description ?? currentPosted.description,
        date: dto.date ?? currentPosted.date,
        category_id:
          dto.category_id !== undefined
            ? dto.category_id
            : currentPosted.category_id || undefined,
        source_container_id:
          dto.source_container_id !== undefined
            ? dto.source_container_id
            : currentPosted.source_container_id || undefined,
        destination_container_id:
          dto.destination_container_id !== undefined
            ? dto.destination_container_id
            : currentPosted.destination_container_id || undefined,
        merchant:
          dto.merchant !== undefined
            ? dto.merchant
            : currentPosted.merchant || undefined,
        currency:
          dto.currency !== undefined
            ? dto.currency
            : containersChanged
              ? undefined
              : currentPosted.currency || undefined,
        exchange_rate:
          dto.exchange_rate !== undefined
            ? dto.exchange_rate
            : containersChanged
              ? undefined
              : currentPosted.exchange_rate,
        notes:
          dto.notes !== undefined ? dto.notes : currentPosted.notes || undefined,
      };

      this.validateShape(merged);
      const nextPosted = await this.buildPostedTx(client, userId, merged);

      await this.reverseJournal(
        client,
        userId,
        id,
        currentPosted,
        'Transaction edited',
      );

      const result = await client.query(
        `UPDATE ledger_transactions SET
           type = $1,
           amount = $2,
           description = $3,
           date = $4,
           category_id = $5,
           source_container_id = $6,
           destination_container_id = $7,
           merchant = $8,
           currency = $9,
           notes = $10,
           exchange_rate = $11,
           fx_rate_to_base = $12,
           amount_base = $13,
           payment_method = $14,
           upi_vpa = $15,
           upi_txn_id = $16,
           payment_status = $17,
           paid_at = $18,
           platform = $19,
           platform_txn_id = $20,
           updated_at = NOW()
         WHERE user_id = $21 AND id = $22 AND deleted_at IS NULL
         RETURNING *`,
        [
          nextPosted.type,
          nextPosted.amount,
          nextPosted.description,
          nextPosted.date,
          nextPosted.category_id || null,
          nextPosted.source_container_id || null,
          nextPosted.destination_container_id || null,
          nextPosted.merchant || null,
          nextPosted.currency,
          nextPosted.notes || null,
          nextPosted.exchange_rate,
          nextPosted.fx_rate_to_base,
          nextPosted.amount_base,
          dto.payment_method !== undefined
            ? dto.payment_method || null
            : currentRow.payment_method,
          dto.upi_vpa !== undefined ? dto.upi_vpa || null : currentRow.upi_vpa,
          dto.upi_txn_id !== undefined
            ? dto.upi_txn_id || null
            : currentRow.upi_txn_id,
          dto.payment_status !== undefined
            ? dto.payment_status || null
            : currentRow.payment_status,
          dto.paid_at !== undefined ? dto.paid_at || null : currentRow.paid_at,
          dto.platform !== undefined ? dto.platform || null : currentRow.platform,
          dto.platform_txn_id !== undefined
            ? dto.platform_txn_id || null
            : currentRow.platform_txn_id,
          userId,
          id,
        ],
      );
      await this.postJournal(
        client,
        userId,
        id,
        nextPosted,
        'transactions',
      );
      const receiptChange = await this.applyReceiptChange(
        client,
        userId,
        id,
        currentRow.receipt_id || null,
        dto.receipt_id,
      );
      await client.query('COMMIT');
      if (receiptChange.released) {
        void this.releaseReceiptFile(userId, receiptChange.released, id);
      }
      if (receiptChange.relocate) {
        void this.relocateReceipt(userId, receiptChange.relocate, nextPosted);
      }
      return this.normalize(receiptChange.row || result.rows[0]);
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.status) throw error;
      throw new BadRequestException(
        error.message || 'Failed to update transaction',
      );
    } finally {
      client.release();
    }
  }

  async remove(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM ledger_transactions
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [userId, id],
      );
      if (!existing.rowCount) {
        throw new NotFoundException('Transaction not found');
      }
      const row = existing.rows[0];
      const posted: PostedTx = {
        type: row.type,
        amount: Number(row.amount),
        currency: row.currency,
        source_container_id: row.source_container_id,
        destination_container_id: row.destination_container_id,
        exchange_rate: Number(row.exchange_rate || 1),
        fx_rate_to_base: Number(row.fx_rate_to_base || 1),
        amount_base: Number(row.amount_base || row.amount),
        description: row.description,
        date: requireDateOnly(row.date),
      };
      await this.reverseJournal(
        client,
        userId,
        id,
        posted,
        'Transaction deleted',
      );
      await client.query(
        `UPDATE ledger_transactions
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      await client.query('COMMIT');
      // Best-effort: drop the scan unless another live transaction uses it.
      void this.releaseReceiptFile(userId, row.receipt_id || null, id);
      return { id, deleted: true };
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.status) throw error;
      throw new BadRequestException(
        error.message || 'Failed to delete transaction',
      );
    } finally {
      client.release();
    }
  }

  private validateShape(dto: CreateTransactionDto) {
    if (dto.type === 'expense' && !dto.source_container_id) {
      throw new BadRequestException(
        'Expense requires a source container (where money left).',
      );
    }
    if (dto.type === 'income' && !dto.destination_container_id) {
      throw new BadRequestException(
        'Income requires a destination container (where money arrived).',
      );
    }
    if (dto.type === 'transfer') {
      if (!dto.source_container_id || !dto.destination_container_id) {
        throw new BadRequestException(
          'Transfer requires both source and destination containers.',
        );
      }
      if (dto.source_container_id === dto.destination_container_id) {
        throw new BadRequestException(
          'Transfer source and destination must differ.',
        );
      }
    }
  }

  private async getUserBaseCurrency(
    client: PoolClient,
    userId: string,
  ): Promise<string> {
    const result = await client.query(
      `SELECT currency FROM users WHERE id = $1`,
      [userId],
    );
    return (result.rows[0]?.currency || 'USD').toUpperCase();
  }

  private async getContainer(
    client: PoolClient,
    userId: string,
    id: string,
  ): Promise<ContainerRow> {
    const result = await client.query(
      `SELECT id, type, balance, currency FROM financial_containers
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         AND space_id IS NULL
       FOR UPDATE`,
      [id, userId],
    );
    if (!result.rowCount) {
      throw new BadRequestException('Financial container not found');
    }
    return result.rows[0];
  }

  private async buildPostedTx(
    client: PoolClient,
    userId: string,
    dto: CreateTransactionDto,
  ): Promise<PostedTx> {
    const baseCurrency = await this.getUserBaseCurrency(client, userId);
    if (dto.category_id) {
      const category = await client.query(
        `SELECT 1 FROM categories
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [dto.category_id, userId],
      );
      if (!category.rowCount) {
        throw new BadRequestException('Category not found');
      }
    }
    let source: ContainerRow | null = null;
    let destination: ContainerRow | null = null;

    if (dto.source_container_id) {
      source = await this.getContainer(client, userId, dto.source_container_id);
    }
    if (dto.destination_container_id) {
      destination = await this.getContainer(
        client,
        userId,
        dto.destination_container_id,
      );
    }

    // Transaction currency defaults to the primary container currency
    const nativeCurrency = (
      dto.currency ||
      source?.currency ||
      destination?.currency ||
      baseCurrency
    ).toUpperCase();

    if (dto.type === 'expense' && source && nativeCurrency !== source.currency) {
      // Amount is always in source container currency for expenses
      if (dto.currency && dto.currency.toUpperCase() !== source.currency) {
        throw new BadRequestException(
          `Expense currency must match source container currency (${source.currency}).`,
        );
      }
    }
    if (
      dto.type === 'income' &&
      destination &&
      dto.currency &&
      dto.currency.toUpperCase() !== destination.currency
    ) {
      throw new BadRequestException(
        `Income currency must match destination container currency (${destination.currency}).`,
      );
    }

    const txCurrency =
      dto.type === 'expense'
        ? (source?.currency || nativeCurrency).toUpperCase()
        : dto.type === 'income'
          ? (destination?.currency || nativeCurrency).toUpperCase()
          : (source?.currency || nativeCurrency).toUpperCase();

    let exchangeRate = 1;
    if (dto.type === 'transfer' && source && destination) {
      if (source.currency === destination.currency) {
        exchangeRate = 1;
      } else {
        exchangeRate =
          dto.exchange_rate && dto.exchange_rate > 0
            ? dto.exchange_rate
            : getRate(source.currency, destination.currency);
      }
    }

    const fxRateToBase = getRate(txCurrency, baseCurrency);
    // Tiny amounts in high-denomination currencies can round to 0 in the base
    // currency, which the journal line side check rejects.
    const amountBase = Math.max(
      0.01,
      convertAmount(dto.amount, txCurrency, baseCurrency),
    );

    return {
      type: dto.type,
      amount: Number(dto.amount),
      currency: txCurrency,
      source_container_id: dto.source_container_id || null,
      destination_container_id: dto.destination_container_id || null,
      source_currency: source?.currency || null,
      destination_currency: destination?.currency || null,
      exchange_rate: exchangeRate,
      fx_rate_to_base: fxRateToBase,
      amount_base: amountBase,
      description: dto.description,
      date: dto.date,
      category_id: dto.category_id || null,
      merchant: dto.merchant || null,
      notes: dto.notes || null,
    };
  }

  private async applyEffects(
    client: PoolClient,
    userId: string,
    dto: PostedTx,
    sign: 1 | -1,
  ) {
    const amount = Number(dto.amount) * sign;
    // Reversals undo an earlier posting; the intermediate balance may dip
    // below zero before the repost, so only enforce on forward postings.
    const enforce = sign === 1;

    if (dto.type === 'expense' && dto.source_container_id) {
      await this.adjustContainer(client, userId, dto.source_container_id, -amount, enforce);
    }

    if (dto.type === 'income' && dto.destination_container_id) {
      await this.adjustContainer(
        client,
        userId,
        dto.destination_container_id,
        amount,
        enforce,
      );
    }

    if (dto.type === 'transfer') {
      if (dto.source_container_id) {
        await this.adjustContainer(
          client,
          userId,
          dto.source_container_id,
          -amount,
          enforce,
        );
      }
      if (dto.destination_container_id) {
        const destDelta = roundMoney(Number(dto.amount) * dto.exchange_rate) * sign;
        await this.adjustContainer(
          client,
          userId,
          dto.destination_container_id,
          destDelta,
          enforce,
        );
      }
    }
  }

  private async postJournal(
    client: PoolClient,
    userId: string,
    transactionId: string,
    dto: PostedTx,
    sourceModule: string,
  ) {
    const baseCurrency = await this.getUserBaseCurrency(client, userId);
    const journal = await client.query(
      `INSERT INTO ledger_journals
        (user_id, transaction_id, description, source_module)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, transactionId, dto.description, sourceModule],
    );
    const journalId = journal.rows[0].id as string;
    const debitContainer =
      dto.type === 'income' || dto.type === 'transfer'
        ? dto.destination_container_id || null
        : null;
    const debitAccount =
      dto.type === 'expense'
        ? `expense:${dto.category_id || 'uncategorized'}`
        : null;
    const creditContainer =
      dto.type === 'expense' || dto.type === 'transfer'
        ? dto.source_container_id || null
        : null;
    const creditAccount =
      dto.type === 'income'
        ? `income:${dto.category_id || 'uncategorized'}`
        : null;
    const debitNativeAmount =
      dto.type === 'transfer'
        ? roundMoney(dto.amount * dto.exchange_rate)
        : dto.amount;

    await client.query(
      `INSERT INTO ledger_journal_lines
        (journal_id, container_id, account_code, debit_base, credit_base,
         native_amount, currency, sequence_number, metadata)
       VALUES
        ($1, $2, $3, $4, 0, $5, $6, 1, $7::jsonb),
        ($1, $8, $9, 0, $4, $10, $11, 2, $7::jsonb)`,
      [
        journalId,
        debitContainer,
        debitAccount,
        dto.amount_base,
        debitNativeAmount,
        dto.type === 'transfer'
          ? dto.destination_currency || baseCurrency
          : dto.currency,
        JSON.stringify({
          transaction_type: dto.type,
          category_id: dto.category_id || null,
        }),
        creditContainer,
        creditAccount,
        dto.amount,
        dto.source_currency || dto.currency,
      ],
    );

    // Container balances are read-model projections updated only by ledger posting.
    await this.applyEffects(client, userId, dto, 1);
  }

  private async reverseJournal(
    client: PoolClient,
    userId: string,
    transactionId: string,
    dto: PostedTx,
    reason: string,
  ) {
    const original = await client.query(
      `SELECT id, description
       FROM ledger_journals
       WHERE user_id = $1::uuid
         AND transaction_id = $2::uuid
         AND reversal_of_journal_id IS NULL
         AND status = 'posted'
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [userId, transactionId],
    );
    if (!original.rowCount) {
      // Legacy or incomplete rows still need balance reversal on edit/delete.
      await this.applyEffects(client, userId, dto, -1);
      return;
    }

    const originalId = original.rows[0].id as string;
    const reversal = await client.query(
      `INSERT INTO ledger_journals
        (user_id, transaction_id, reversal_of_journal_id, description, source_module)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'transaction_reversal')
       RETURNING id`,
      [userId, transactionId, originalId, `${reason}: ${dto.description}`],
    );
    const reversalId = reversal.rows[0].id as string;

    await client.query(
      `INSERT INTO ledger_journal_lines
        (journal_id, container_id, account_code, debit_base, credit_base,
         native_amount, currency, sequence_number, metadata)
       SELECT
         $1::uuid,
         container_id,
         account_code,
         credit_base,
         debit_base,
         native_amount,
         currency,
         sequence_number,
         metadata || jsonb_build_object('reversal_of_journal_id', $2::uuid::text)
       FROM ledger_journal_lines
       WHERE journal_id = $2::uuid AND native_amount > 0
       ORDER BY sequence_number`,
      [reversalId, originalId],
    );

    await this.applyEffects(client, userId, dto, -1);
    await client.query(
      `UPDATE ledger_journals
       SET status = 'reversed'
       WHERE id = $1::uuid AND user_id = $2::uuid`,
      [originalId, userId],
    );
  }

  private async adjustContainer(
    client: PoolClient,
    userId: string,
    containerId: string,
    signedAmount: number,
    enforce = true,
  ) {
    // Reversals may touch archived containers (editing/deleting history).
    const result = await client.query(
      `SELECT id, type, balance FROM financial_containers
       WHERE id = $1 AND user_id = $2 AND ($3::boolean OR deleted_at IS NULL)
       FOR UPDATE`,
      [containerId, userId, !enforce],
    );
    if (!result.rowCount) {
      throw new BadRequestException('Financial container not found');
    }
    const row = result.rows[0];
    const isLiability = LIABILITY_TYPES.has(row.type);
    const delta = isLiability ? -signedAmount : signedAmount;
    const nextBalance = Number(row.balance) + delta;
    if (enforce && nextBalance < -0.005) {
      throw new BadRequestException(
        isLiability
          ? 'This payment exceeds the outstanding liability balance.'
          : 'This transaction would make the source container balance negative.',
      );
    }
    await client.query(
      `UPDATE financial_containers
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [delta, containerId, userId],
    );
  }

  private async attachReceipt(
    client: PoolClient,
    userId: string,
    transactionId: string,
    receiptId: string | null | undefined,
    posted: ReceiptContext,
  ) {
    if (!receiptId) return null;
    const linked = await client.query(
      `UPDATE receipts
       SET ledger_transaction_id = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, file_path, mime_type, stored_file_id`,
      [transactionId, receiptId, userId],
    );
    if (!linked.rowCount) return null;
    const file = linked.rows[0];
    const media = await client.query(
      `SELECT id, public_token, mime_type FROM stored_files
       WHERE user_id = $1 AND deleted_at IS NULL
         AND (id = $2 OR object_key = $3)
       LIMIT 1`,
      [userId, file.stored_file_id || null, file.file_path],
    );
    const stored = media.rows[0] as
      | { id: string; public_token: string; mime_type: string | null }
      | undefined;
    if (stored && stored.id !== file.stored_file_id) {
      await client.query(
        `UPDATE receipts SET stored_file_id = $2 WHERE id = $1`,
        [file.id, stored.id],
      );
    }
    const updated = await client.query(
      `UPDATE ledger_transactions
       SET receipt_id = $2,
           receipt_url = $3,
           receipt_mime = $4
       WHERE id = $1 AND user_id = $5
       RETURNING *`,
      [
        transactionId,
        file.id,
        stored ? `/api/media/${stored.public_token}` : null,
        stored?.mime_type || file.mime_type || null,
        userId,
      ],
    );
    if (stored) {
      // File the scan under the transaction date / merchant. Runs outside
      // this DB transaction; the token (and receipt_url) never changes.
      if (posted) {
        const fileId = stored.id;
        setImmediate(() => {
          void this.storage.relocateFile(fileId, userId, {
            date: posted.date,
            label: posted.merchant || posted.description || null,
          });
        });
      }
    }
    return updated.rows[0] || null;
  }

  /**
   * receipt_id on update: undefined = untouched, null/'' = detach,
   * another id = replace. Returns what to clean up after COMMIT.
   */
  private async applyReceiptChange(
    client: PoolClient,
    userId: string,
    transactionId: string,
    currentReceiptId: string | null,
    requested: string | null | undefined,
  ): Promise<{
    row: Record<string, any> | null;
    released: string | null;
    relocate: string | null;
  }> {
    if (requested === undefined || (requested && requested === currentReceiptId)) {
      // Date / merchant may have changed: re-file the existing scan.
      return { row: null, released: null, relocate: currentReceiptId };
    }
    let row: Record<string, any> | null = null;
    if (requested) {
      const linked = await client.query(
        `SELECT id FROM receipts WHERE id = $1 AND user_id = $2`,
        [requested, userId],
      );
      if (!linked.rowCount) {
        // Same as create: an unknown / foreign receipt id is ignored.
        return { row: null, released: null, relocate: currentReceiptId };
      }
      // Relocation happens after COMMIT via `relocate` below.
      row = await this.attachReceipt(client, userId, transactionId, requested, null);
    } else {
      const cleared = await client.query(
        `UPDATE ledger_transactions
         SET receipt_id = NULL, receipt_url = NULL, receipt_mime = NULL
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [transactionId, userId],
      );
      row = cleared.rows[0] || null;
    }
    if (currentReceiptId) {
      await client.query(
        `UPDATE receipts
         SET ledger_transaction_id = NULL, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND ledger_transaction_id = $3`,
        [currentReceiptId, userId, transactionId],
      );
    }
    return { row, released: currentReceiptId, relocate: requested || null };
  }

  /** Move a receipt scan to receipts/{YYYY}/{MM}/{yyyymmdd}-{merchant}-... */
  private async relocateReceipt(
    userId: string,
    receiptId: string,
    posted: ReceiptContext,
  ) {
    if (!posted) return;
    try {
      const found = await this.pgPool.query(
        `SELECT stored_file_id FROM receipts WHERE id = $1 AND user_id = $2`,
        [receiptId, userId],
      );
      const fileId = found.rows[0]?.stored_file_id as string | undefined;
      if (!fileId) return;
      await this.storage.relocateFile(fileId, userId, {
        date: posted.date,
        label: posted.merchant || posted.description || null,
      });
    } catch (error) {
      this.logger.warn(
        `Receipt ${receiptId} relocation skipped: ${describeError(error)}`,
      );
    }
  }

  /**
   * Delete a receipt's stored scan once no live transaction references it.
   * Best-effort and logged; never fails the user action.
   */
  private async releaseReceiptFile(
    userId: string,
    receiptId: string | null,
    transactionId: string,
  ) {
    try {
      const receipts = await this.pgPool.query(
        `SELECT r.id, r.stored_file_id, r.file_path
         FROM receipts r
         WHERE r.user_id = $1
           AND (r.id = $2 OR r.ledger_transaction_id = $3)
           AND NOT EXISTS (
             SELECT 1 FROM ledger_transactions t
             WHERE t.user_id = $1 AND t.receipt_id = r.id
               AND t.deleted_at IS NULL
           )`,
        [userId, receiptId, transactionId],
      );
      for (const receipt of receipts.rows) {
        let fileId = receipt.stored_file_id as string | null;
        if (!fileId) {
          const byKey = await this.pgPool.query(
            `SELECT id FROM stored_files WHERE user_id = $1 AND object_key = $2`,
            [userId, receipt.file_path],
          );
          fileId = (byKey.rows[0]?.id as string | undefined) || null;
        }
        if (fileId) await this.storage.deleteFileById(fileId, userId);
        await this.pgPool.query(
          `UPDATE receipts
           SET processing_status = 'file_deleted', updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [receipt.id, userId],
        );
      }
    } catch (error) {
      this.logger.warn(
        `Receipt cleanup for transaction ${transactionId} skipped: ${describeError(error)}`,
      );
    }
  }

  private normalize(row: Record<string, any>): Record<string, any> {
    return {
      ...row,
      amount: Number(row.amount),
      exchange_rate: Number(row.exchange_rate ?? 1),
      fx_rate_to_base: Number(row.fx_rate_to_base ?? 1),
      amount_base: Number(row.amount_base ?? row.amount),
      date: requireDateOnly(row.date),
    };
  }
}
