import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { TransactionsService } from '../transactions/transactions.service';
import {
  CreateLoanDto,
  RecordLoanPaymentDto,
  UpdateLoanDto,
} from './dto/loan.dto';
import { requireDateOnly } from 'src/common/date/to-date-only';
import { roundMoney } from 'src/common/currency/currency.data';

@Injectable()
export class LoansService {
  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    private readonly transactionsService: TransactionsService,
  ) {}

  async create(userId: string, dto: CreateLoanDto) {
    await this.assertLiabilityContainer(userId, dto.container_id);
    try {
      const clientId = (dto as { id?: string }).id;
      const result = await this.pgPool.query(
        clientId
          ? `INSERT INTO loans
              (id, user_id, container_id, name, lender, principal,
               annual_interest_rate, interest_type, term_months,
               start_date, payment_day, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING id`
          : `INSERT INTO loans
              (user_id, container_id, name, lender, principal,
               annual_interest_rate, interest_type, term_months,
               start_date, payment_day, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id`,
        clientId
          ? [
              clientId,
              userId,
              dto.container_id,
              dto.name.trim(),
              dto.lender?.trim() || null,
              dto.principal,
              dto.annual_interest_rate,
              dto.interest_type || 'fixed',
              dto.term_months,
              dto.start_date,
              dto.payment_day || null,
              dto.notes?.trim() || null,
            ]
          : [
              userId,
              dto.container_id,
              dto.name.trim(),
              dto.lender?.trim() || null,
              dto.principal,
              dto.annual_interest_rate,
              dto.interest_type || 'fixed',
              dto.term_months,
              dto.start_date,
              dto.payment_day || null,
              dto.notes?.trim() || null,
            ],
      );
      return this.findOne(userId, result.rows[0].id);
    } catch (error: any) {
      if (error?.code === '23505') {
        throw new BadRequestException(
          'This liability container is already linked to a debt plan.',
        );
      }
      if (error?.status) throw error;
      throw new BadRequestException(error.message || 'Could not create debt');
    }
  }

  async findAll(userId: string) {
    const result = await this.pgPool.query(
      `${this.selectSql()}
       WHERE l.user_id = $1 AND l.deleted_at IS NULL
       ORDER BY
         CASE l.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
         l.created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => this.normalize(row));
  }

  async findOne(userId: string, id: string) {
    const result = await this.pgPool.query(
      `${this.selectSql()}
       WHERE l.user_id = $1 AND l.id = $2 AND l.deleted_at IS NULL`,
      [userId, id],
    );
    if (!result.rowCount) throw new NotFoundException('Debt plan not found');
    return this.normalize(result.rows[0]);
  }

  async update(userId: string, id: string, dto: UpdateLoanDto) {
    const existing = await this.findOne(userId, id);
    if (dto.container_id && dto.container_id !== existing.container_id) {
      await this.assertLiabilityContainer(userId, dto.container_id);
    }
    const allowed = [
      'container_id',
      'name',
      'lender',
      'principal',
      'annual_interest_rate',
      'interest_type',
      'term_months',
      'start_date',
      'payment_day',
      'status',
      'notes',
    ] as const;
    const fields = allowed.filter((field) => dto[field] !== undefined);
    if (!fields.length) throw new BadRequestException('No values to update');
    const values: unknown[] = fields.map((field) => dto[field] ?? null);
    values.push(userId, id);
    try {
      await this.pgPool.query(
        `UPDATE loans
         SET ${fields.map((field, index) => `${field} = $${index + 1}`).join(', ')},
             updated_at = NOW()
         WHERE user_id = $${values.length - 1}
           AND id = $${values.length}
           AND deleted_at IS NULL`,
        values,
      );
      return this.findOne(userId, id);
    } catch (error: any) {
      if (error?.code === '23505') {
        throw new BadRequestException(
          'This liability container is already linked to a debt plan.',
        );
      }
      if (error?.status) throw error;
      throw new BadRequestException(error.message || 'Could not update debt');
    }
  }

  async archive(userId: string, id: string) {
    const result = await this.pgPool.query(
      `UPDATE loans
       SET status = 'archived', deleted_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [userId, id],
    );
    if (!result.rowCount) throw new NotFoundException('Debt plan not found');
    return { id, archived: true };
  }

  async recordPayment(
    userId: string,
    id: string,
    dto: RecordLoanPaymentDto,
  ) {
    const loan = await this.findOne(userId, id);
    if (loan.status !== 'active') {
      throw new BadRequestException('Only active debts can receive payments.');
    }
    if (dto.amount > loan.outstanding_balance + 0.005) {
      throw new BadRequestException(
        'Payment cannot exceed the outstanding balance.',
      );
    }
    const transaction = await this.transactionsService.create(userId, {
      type: 'transfer',
      amount: dto.amount,
      description: `Debt payment · ${loan.name}`,
      date: dto.date,
      source_container_id: dto.source_container_id,
      destination_container_id: loan.container_id,
      exchange_rate: dto.exchange_rate,
      notes: dto.notes || `Loan payment for ${loan.name}`,
    });
    const refreshed = await this.findOne(userId, id);
    if (refreshed.outstanding_balance <= 0.005) {
      await this.pgPool.query(
        `UPDATE loans SET status = 'closed', updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
    }
    return { transaction, loan: await this.findOne(userId, id) };
  }

  async amortization(userId: string, id: string) {
    const loan = await this.findOne(userId, id);
    const monthlyRate = loan.annual_interest_rate / 100 / 12;
    const payment = this.monthlyPayment(
      loan.principal,
      loan.annual_interest_rate,
      loan.term_months,
      loan.interest_type,
    );
    let balance = loan.principal;
    const start = new Date(`${loan.start_date}T00:00:00`);
    const schedule: Array<{
      installment: number;
      due_date: string;
      payment: number;
      principal: number;
      interest: number;
      outstanding_balance: number;
    }> = [];
    for (
      let installment = 1;
      installment <= loan.term_months && balance > 0.005;
      installment += 1
    ) {
      const interest =
        loan.interest_type === 'simple'
          ? roundMoney(
              (loan.principal *
                (loan.annual_interest_rate / 100) *
                (loan.term_months / 12)) /
                loan.term_months,
            )
          : roundMoney(balance * monthlyRate);
      const principal =
        loan.interest_type === 'simple'
          ? roundMoney(Math.min(balance, loan.principal / loan.term_months))
          : roundMoney(Math.min(balance, payment - interest));
      balance = roundMoney(Math.max(0, balance - principal));
      const due = new Date(start);
      due.setMonth(start.getMonth() + installment);
      if (loan.payment_day) {
        due.setDate(
          Math.min(
            loan.payment_day,
            new Date(due.getFullYear(), due.getMonth() + 1, 0).getDate(),
          ),
        );
      }
      schedule.push({
        installment,
        due_date: [
          due.getFullYear(),
          String(due.getMonth() + 1).padStart(2, '0'),
          String(due.getDate()).padStart(2, '0'),
        ].join('-'),
        payment: roundMoney(principal + interest),
        principal,
        interest,
        outstanding_balance: balance,
      });
    }
    return schedule;
  }

  private selectSql() {
    return `SELECT
      l.*,
      c.name AS container_name,
      c.type AS container_type,
      c.balance AS outstanding_balance,
      c.currency
    FROM loans l
    JOIN financial_containers c
      ON c.id = l.container_id AND c.user_id = l.user_id`;
  }

  private normalize(row: Record<string, any>): Record<string, any> {
    const principal = Number(row.principal);
    const outstanding = Number(row.outstanding_balance);
    const term = Number(row.term_months);
    const rate = Number(row.annual_interest_rate);
    const monthlyPayment = this.monthlyPayment(
      principal,
      rate,
      term,
      row.interest_type,
    );
    return {
      ...row,
      principal,
      annual_interest_rate: rate,
      term_months: term,
      outstanding_balance: outstanding,
      monthly_payment: monthlyPayment,
      paid_amount: Math.max(0, roundMoney(principal - outstanding)),
      payoff_percent:
        principal > 0
          ? Math.max(0, Math.min(100, ((principal - outstanding) / principal) * 100))
          : 0,
      estimated_months_remaining:
        monthlyPayment > 0 ? Math.ceil(outstanding / monthlyPayment) : null,
      start_date: requireDateOnly(row.start_date),
    };
  }

  private monthlyPayment(
    principal: number,
    annualRate: number,
    months: number,
    interestType = 'fixed',
  ) {
    if (!months) return 0;
    if (interestType === 'simple') {
      const interest = principal * (annualRate / 100) * (months / 12);
      return roundMoney((principal + interest) / months);
    }
    const rate = annualRate / 100 / 12;
    if (!rate) return roundMoney(principal / months);
    const factor = Math.pow(1 + rate, months);
    return roundMoney((principal * rate * factor) / (factor - 1));
  }

  private async assertLiabilityContainer(userId: string, containerId: string) {
    const result = await this.pgPool.query(
      `SELECT id FROM financial_containers
       WHERE id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND type IN ('loan', 'credit_card', 'payable')`,
      [containerId, userId],
    );
    if (!result.rowCount) {
      throw new BadRequestException(
        'Select an active loan, credit card, or payable container.',
      );
    }
  }
}
