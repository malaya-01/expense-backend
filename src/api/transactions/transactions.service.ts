import {
  BadRequestException,
  Inject,
  Injectable,
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

const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'payable']);

type ContainerRow = {
  id: string;
  type: string;
  balance: string | number;
  currency: string;
};

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
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async create(userId: string, dto: CreateTransactionDto) {
    this.validateShape(dto);
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const posted = await this.buildPostedTx(client, userId, dto);
      const result = await client.query(
        `INSERT INTO ledger_transactions
          (user_id, type, amount, description, date, category_id,
           source_container_id, destination_container_id, merchant, currency, notes,
           exchange_rate, fx_rate_to_base, amount_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
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
        ],
      );
      await this.postJournal(
        client,
        userId,
        result.rows[0].id,
        posted,
        'transactions',
      );
      await client.query('COMMIT');
      return this.normalize(result.rows[0]);
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
            : currentPosted.currency || undefined,
        exchange_rate:
          dto.exchange_rate !== undefined
            ? dto.exchange_rate
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
           updated_at = NOW()
         WHERE user_id = $14 AND id = $15 AND deleted_at IS NULL
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
      await client.query('COMMIT');
      return this.normalize(result.rows[0]);
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
    const amountBase = convertAmount(dto.amount, txCurrency, baseCurrency);

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

    if (dto.type === 'expense' && dto.source_container_id) {
      await this.adjustContainer(client, userId, dto.source_container_id, -amount);
    }

    if (dto.type === 'income' && dto.destination_container_id) {
      await this.adjustContainer(
        client,
        userId,
        dto.destination_container_id,
        amount,
      );
    }

    if (dto.type === 'transfer') {
      if (dto.source_container_id) {
        await this.adjustContainer(
          client,
          userId,
          dto.source_container_id,
          -amount,
        );
      }
      if (dto.destination_container_id) {
        const destDelta = roundMoney(Number(dto.amount) * dto.exchange_rate) * sign;
        await this.adjustContainer(
          client,
          userId,
          dto.destination_container_id,
          destDelta,
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
       WHERE user_id = $1
         AND transaction_id = $2
         AND reversal_of_journal_id IS NULL
         AND status = 'posted'
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [userId, transactionId],
    );
    if (!original.rowCount) {
      throw new BadRequestException(
        'Posted journal not found; transaction cannot be safely reversed.',
      );
    }

    const originalId = original.rows[0].id as string;
    const reversal = await client.query(
      `INSERT INTO ledger_journals
        (user_id, transaction_id, reversal_of_journal_id, description, source_module)
       VALUES ($1, $2, $3, $4, 'transaction_reversal')
       RETURNING id`,
      [userId, transactionId, originalId, `${reason}: ${dto.description}`],
    );
    const reversalId = reversal.rows[0].id as string;

    await client.query(
      `INSERT INTO ledger_journal_lines
        (journal_id, container_id, account_code, debit_base, credit_base,
         native_amount, currency, sequence_number, metadata)
       SELECT
         $1,
         container_id,
         account_code,
         credit_base,
         debit_base,
         native_amount,
         currency,
         sequence_number,
         metadata || jsonb_build_object('reversal_of_journal_id', $2::text)
       FROM ledger_journal_lines
       WHERE journal_id = $2
       ORDER BY sequence_number`,
      [reversalId, originalId],
    );

    await this.applyEffects(client, userId, dto, -1);
    await client.query(
      `UPDATE ledger_journals
       SET status = 'reversed'
       WHERE id = $1 AND user_id = $2`,
      [originalId, userId],
    );
  }

  private async adjustContainer(
    client: PoolClient,
    userId: string,
    containerId: string,
    signedAmount: number,
  ) {
    const result = await client.query(
      `SELECT id, type, balance FROM financial_containers
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [containerId, userId],
    );
    if (!result.rowCount) {
      throw new BadRequestException('Financial container not found');
    }
    const row = result.rows[0];
    const isLiability = LIABILITY_TYPES.has(row.type);
    const delta = isLiability ? -signedAmount : signedAmount;
    const nextBalance = Number(row.balance) + delta;
    if (nextBalance < -0.005) {
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
