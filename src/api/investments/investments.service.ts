import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { convertAmount } from 'src/common/currency/currency.data';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';

const INVEST_CONTAINER_TYPES = new Set(['investment', 'gold', 'crypto']);

@Injectable()
export class InvestmentsService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
  ) {}

  async create(userId: string, dto: CreateInvestmentDto) {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const baseCurrency = await this.getUserCurrency(client, userId);
      if (dto.container_id) {
        await this.assertInvestContainer(client, userId, dto.container_id);
      }

      const clientId = (dto as { id?: string }).id;
      const result = await client.query(
        clientId
          ? `INSERT INTO investment_holdings
              (id, user_id, container_id, name, symbol, asset_type, quantity, avg_cost, current_price, currency, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`
          : `INSERT INTO investment_holdings
              (user_id, container_id, name, symbol, asset_type, quantity, avg_cost, current_price, currency, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
        clientId
          ? [
              clientId,
              userId,
              dto.container_id || null,
              dto.name.trim(),
              dto.symbol?.trim().toUpperCase() || null,
              dto.asset_type || 'other',
              dto.quantity,
              dto.avg_cost,
              dto.current_price,
              (dto.currency || baseCurrency).toUpperCase(),
              dto.notes || null,
            ]
          : [
              userId,
              dto.container_id || null,
              dto.name.trim(),
              dto.symbol?.trim().toUpperCase() || null,
              dto.asset_type || 'other',
              dto.quantity,
              dto.avg_cost,
              dto.current_price,
              (dto.currency || baseCurrency).toUpperCase(),
              dto.notes || null,
            ],
      );

      if (dto.container_id) {
        await this.syncContainerBalance(client, userId, dto.container_id);
      }

      await client.query('COMMIT');
      return this.enrich(result.rows[0], baseCurrency);
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.status === 400 || error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to create holding',
      );
    } finally {
      client.release();
    }
  }

  async findAll(userId: string) {
    const client = await this.pgPool.connect();
    try {
      const baseCurrency = await this.getUserCurrency(client, userId);
      const result = await client.query(
        `SELECT h.*,
                fc.name AS container_name,
                fc.type AS container_type
         FROM investment_holdings h
         LEFT JOIN financial_containers fc
           ON fc.id = h.container_id AND fc.deleted_at IS NULL
         WHERE h.user_id = $1 AND h.deleted_at IS NULL
         ORDER BY h.name ASC`,
        [userId],
      );
      const holdings = result.rows.map((row) =>
        this.enrich(row, baseCurrency),
      );
      return {
        holdings,
        summary: this.summarize(holdings, baseCurrency),
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to fetch investments',
      );
    } finally {
      client.release();
    }
  }

  async findOne(userId: string, id: string) {
    const client = await this.pgPool.connect();
    try {
      const baseCurrency = await this.getUserCurrency(client, userId);
      const result = await client.query(
        `SELECT h.*,
                fc.name AS container_name,
                fc.type AS container_type
         FROM investment_holdings h
         LEFT JOIN financial_containers fc
           ON fc.id = h.container_id AND fc.deleted_at IS NULL
         WHERE h.user_id = $1 AND h.id = $2 AND h.deleted_at IS NULL`,
        [userId, id],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Holding not found');
      }
      return this.enrich(result.rows[0], baseCurrency);
    } catch (error: any) {
      if (error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to fetch holding',
      );
    } finally {
      client.release();
    }
  }

  async update(userId: string, id: string, dto: UpdateInvestmentDto) {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM investment_holdings
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [id, userId],
      );
      if (!existing.rowCount) {
        throw new NotFoundException('Holding not found');
      }
      const prev = existing.rows[0];

      if (dto.container_id) {
        await this.assertInvestContainer(client, userId, dto.container_id);
      }

      const allowed = [
        'name',
        'symbol',
        'asset_type',
        'quantity',
        'avg_cost',
        'current_price',
        'currency',
        'container_id',
        'notes',
      ] as const;
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;

      for (const key of allowed) {
        if (dto[key] === undefined) continue;
        let value: unknown = dto[key];
        if (key === 'name' && typeof value === 'string') value = value.trim();
        if (key === 'symbol' && typeof value === 'string') {
          value = value.trim().toUpperCase() || null;
        }
        if (key === 'currency' && typeof value === 'string') {
          value = value.toUpperCase();
        }
        if (key === 'container_id' && (value === '' || value === null)) {
          value = null;
        }
        sets.push(`${key} = $${i++}`);
        values.push(value);
      }

      if (sets.length === 0) {
        await client.query('COMMIT');
        return this.findOne(userId, id);
      }

      sets.push('updated_at = NOW()');
      values.push(id, userId);

      const result = await client.query(
        `UPDATE investment_holdings
         SET ${sets.join(', ')}
         WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
         RETURNING *`,
        values,
      );

      const nextContainerId =
        dto.container_id !== undefined
          ? dto.container_id || null
          : prev.container_id;

      const containersToSync = new Set<string>();
      if (prev.container_id) containersToSync.add(prev.container_id);
      if (nextContainerId) containersToSync.add(nextContainerId);
      for (const cid of containersToSync) {
        await this.syncContainerBalance(client, userId, cid);
      }

      await client.query('COMMIT');

      const baseCurrency = await this.getUserCurrency(client, userId);
      const enriched = await client.query(
        `SELECT h.*,
                fc.name AS container_name,
                fc.type AS container_type
         FROM investment_holdings h
         LEFT JOIN financial_containers fc
           ON fc.id = h.container_id AND fc.deleted_at IS NULL
         WHERE h.id = $1`,
        [id],
      );
      return this.enrich(enriched.rows[0] || result.rows[0], baseCurrency);
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.status === 400 || error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to update holding',
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
        `SELECT id, container_id FROM investment_holdings
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [id, userId],
      );
      if (!existing.rowCount) {
        throw new NotFoundException('Holding not found');
      }

      await client.query(
        `UPDATE investment_holdings
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );

      if (existing.rows[0].container_id) {
        await this.syncContainerBalance(
          client,
          userId,
          existing.rows[0].container_id,
        );
      }

      await client.query('COMMIT');
      return { id };
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.status === 404) throw error;
      throw new BadRequestException(
        error.message || 'Failed to delete holding',
      );
    } finally {
      client.release();
    }
  }

  private async assertInvestContainer(
    client: PoolClient,
    userId: string,
    containerId: string,
  ) {
    const result = await client.query(
      `SELECT id, type FROM financial_containers
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [containerId, userId],
    );
    if (!result.rowCount) {
      throw new BadRequestException('Financial container not found');
    }
    if (!INVEST_CONTAINER_TYPES.has(result.rows[0].type)) {
      throw new BadRequestException(
        'Link holdings only to investment, gold, or crypto containers.',
      );
    }
  }

  private async syncContainerBalance(
    client: PoolClient,
    userId: string,
    containerId: string,
  ) {
    const container = await client.query(
      `SELECT id, currency FROM financial_containers
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [containerId, userId],
    );
    if (!container.rowCount) return;

    const containerCurrency = String(
      container.rows[0].currency || 'USD',
    ).toUpperCase();

    const holdings = await client.query(
      `SELECT quantity, current_price, currency
       FROM investment_holdings
       WHERE user_id = $1 AND container_id = $2 AND deleted_at IS NULL`,
      [userId, containerId],
    );

    let total = 0;
    for (const h of holdings.rows) {
      const market = Number(h.quantity) * Number(h.current_price);
      total += convertAmount(
        market,
        String(h.currency || containerCurrency).toUpperCase(),
        containerCurrency,
      );
    }

    await client.query(
      `UPDATE financial_containers
       SET balance = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [Math.round((total + Number.EPSILON) * 100) / 100, containerId, userId],
    );
  }

  private async getUserCurrency(
    client: PoolClient,
    userId: string,
  ): Promise<string> {
    const result = await client.query(
      `SELECT currency FROM users WHERE id = $1`,
      [userId],
    );
    return (result.rows[0]?.currency || 'USD').toUpperCase();
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private enrich(row: any, baseCurrency: string) {
    const quantity = Number(row.quantity);
    const avgCost = Number(row.avg_cost);
    const currentPrice = Number(row.current_price);
    const currency = String(row.currency || 'USD').toUpperCase();
    const costBasis = this.round(quantity * avgCost);
    const marketValue = this.round(quantity * currentPrice);
    const gain = this.round(marketValue - costBasis);
    const gainPercent =
      costBasis > 0
        ? Math.round(((gain / costBasis) * 100 + Number.EPSILON) * 10) / 10
        : 0;
    const marketValueBase = convertAmount(marketValue, currency, baseCurrency);
    const costBasisBase = convertAmount(costBasis, currency, baseCurrency);

    return {
      id: row.id,
      user_id: row.user_id,
      container_id: row.container_id,
      container_name: row.container_name || null,
      container_type: row.container_type || null,
      name: row.name,
      symbol: row.symbol,
      asset_type: row.asset_type,
      quantity,
      avg_cost: avgCost,
      current_price: currentPrice,
      currency,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      cost_basis: costBasis,
      market_value: marketValue,
      gain,
      gain_percent: gainPercent,
      market_value_base: marketValueBase,
      cost_basis_base: costBasisBase,
      base_currency: baseCurrency,
    };
  }

  private summarize(holdings: ReturnType<InvestmentsService['enrich']>[], baseCurrency: string) {
    const totalValue = this.round(
      holdings.reduce((s, h) => s + h.market_value_base, 0),
    );
    const totalCost = this.round(
      holdings.reduce((s, h) => s + h.cost_basis_base, 0),
    );
    const totalGain = this.round(totalValue - totalCost);
    const gainPercent =
      totalCost > 0
        ? Math.round(((totalGain / totalCost) * 100 + Number.EPSILON) * 10) / 10
        : 0;

    const byType = new Map<string, number>();
    for (const h of holdings) {
      byType.set(
        h.asset_type,
        this.round((byType.get(h.asset_type) || 0) + h.market_value_base),
      );
    }

    const allocation = [...byType.entries()]
      .map(([asset_type, value]) => ({
        asset_type,
        value,
        percent:
          totalValue > 0
            ? Math.round(((value / totalValue) * 100 + Number.EPSILON) * 10) /
              10
            : 0,
      }))
      .sort((a, b) => b.value - a.value);

    return {
      base_currency: baseCurrency,
      holding_count: holdings.length,
      total_value: totalValue,
      total_cost: totalCost,
      total_gain: totalGain,
      gain_percent: gainPercent,
      allocation,
    };
  }
}
