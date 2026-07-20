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
      await this.applyEffects(client, userId, posted, 1);
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
        date: String(currentRow.date).slice(0, 10),
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

      await this.applyEffects(client, userId, currentPosted, -1);
      await this.applyEffects(client, userId, nextPosted, 1);

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
        date: String(row.date).slice(0, 10),
      };
      await this.applyEffects(client, userId, posted, -1);
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
    await client.query(
      `UPDATE financial_containers
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [delta, containerId, userId],
    );
  }

  private normalize(row: Record<string, any>) {
    return {
      ...row,
      amount: Number(row.amount),
      exchange_rate: Number(row.exchange_rate ?? 1),
      fx_rate_to_base: Number(row.fx_rate_to_base ?? 1),
      amount_base: Number(row.amount_base ?? row.amount),
      date:
        typeof row.date === 'string'
          ? row.date.slice(0, 10)
          : new Date(row.date).toISOString().slice(0, 10),
    };
  }
}
