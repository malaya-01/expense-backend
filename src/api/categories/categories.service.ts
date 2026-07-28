import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Pool } from 'pg';
import {
  CATEGORY_ICON_IDS,
  normalizeCategoryIcon,
} from './category-icons';

@Injectable()
export class CategoriesService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool
  ) { }

  async create(user_id: string, createCategoryDto: CreateCategoryDto) {
    const { name, description, color, icon, parent_id, is_system, budget_amount, budget_period } = createCategoryDto
    const client = await this.pgPool.connect()
    const normalizedIcon = normalizeCategoryIcon(icon)
    
    try {
      const existingCategory = await client.query(
        `SELECT id FROM categories WHERE name = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [name, user_id]
      )
      
      if (existingCategory.rowCount !== 0) {
        throw new BadRequestException('A category with this name already exists.')
      }

      const clientId = (createCategoryDto as { id?: string }).id
      const result = await client.query(
        clientId
          ? `INSERT INTO categories (id, user_id, name, description, color, icon, parent_id, is_system, budget_amount, budget_period) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
             RETURNING id, user_id, name, description, color, icon, parent_id, is_system, budget_amount, budget_period, created_at, updated_at`
          : `INSERT INTO categories (user_id, name, description, color, icon, parent_id, is_system, budget_amount, budget_period) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
             RETURNING id, user_id, name, description, color, icon, parent_id, is_system, budget_amount, budget_period, created_at, updated_at`,
        clientId
          ? [clientId, user_id, name, description || null, color || null, normalizedIcon, parent_id || null, is_system || false, budget_amount || null, budget_period || null]
          : [user_id, name, description || null, color || null, normalizedIcon, parent_id || null, is_system || false, budget_amount || null, budget_period || null]
      )

      return result.rows[0]
    } catch(error: any) {
      if (error.message?.includes('A category with this name already exists')) {
        throw error
      }
      throw new BadRequestException(error.message || 'Failed to create category')
    } finally {
      client.release()
    }
  }

  listIcons() {
    return CATEGORY_ICON_IDS.map((id) => ({ id }))
  }

  async findAll(user_id: String) {
    const client = await this.pgPool.connect()
    try{
      const result = await client.query(
        `
        SELECT
          c.id,
          c.user_id,
          c.name,
          c.description,
          c.color,
          c.icon,
          c.parent_id,
          c.is_system,
          c.budget_amount,
          c.budget_period,
          c.created_at,
          c.updated_at,
          COALESCE(stats.spent_amount, 0)::float8 AS spent_amount,
          COALESCE(stats.transaction_count, 0)::int AS transaction_count
        FROM categories c
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(COALESCE(t.amount_base, t.amount)), 0) AS spent_amount,
            COUNT(*)::int AS transaction_count
          FROM ledger_transactions t
          WHERE t.user_id = c.user_id
            AND t.category_id = c.id
            AND t.deleted_at IS NULL
            AND t.type = 'expense'
            AND t.date >= CASE UPPER(COALESCE(c.budget_period, 'MONTHLY'))
              WHEN 'DAILY' THEN CURRENT_DATE
              WHEN 'WEEKLY' THEN date_trunc('week', CURRENT_DATE)::date
              WHEN 'YEARLY' THEN date_trunc('year', CURRENT_DATE)::date
              ELSE date_trunc('month', CURRENT_DATE)::date
            END
        ) stats ON TRUE
        WHERE c.user_id = $1
          AND c.deleted_at IS NULL
        ORDER BY c.name ASC
        `,
        [user_id],
      )
      return result.rows
    }catch(error: any){
      throw new BadRequestException(error.message || 'Failed to fetch categories')
    }finally{
      client.release()
    }
  }

  async findOne(user_id: string, category_id:string) {
    const client = await this.pgPool.connect()
    try{
      const currentUser = await client.query(`
        SELECT * FROM categories WHERE user_id = $1
        `, [user_id])
      if (currentUser.rowCount === 0){
        throw new BadRequestException('No user found')
      }else{
        const categories = await client.query(`
          SELECT * FROM categories where user_id = $1 AND id = $2
          `,[user_id, category_id])
        return categories.rows[0]
      }
    }catch(error: any){
      throw new BadRequestException('Something went wrong')
    }finally{
      await client.release()
    }
  }

  async update(user_id:string, category_id: string, updateCategoryDto: UpdateCategoryDto) {
    const client = await this.pgPool.connect()

    try{
      const payload = { ...updateCategoryDto } as Record<string, unknown>
      if (payload.icon !== undefined) {
        payload.icon = normalizeCategoryIcon(
          typeof payload.icon === 'string' ? payload.icon : null,
        )
      }
      const fields = Object.keys(payload)
      if (fields.length === 0){
        throw new BadRequestException('No values found to update.')
      }

      const setClause = fields.map((field, index)=>`${field} = $${index+1}`).join(', ');
      const values = Object.values(payload)
      values.push(user_id, category_id)

      const query =  `UPDATE categories SET ${setClause}, updated_at = NOW() WHERE user_id = $${values.length -1} AND id = $${values.length} RETURNING *
      `
      const result = await client.query(query, values)
      if(result.rowCount === 0){
        throw new BadRequestException("Category not found.")
      }

      return result.rows[0]
    }catch(error){
      console.log(error)
      throw new BadRequestException("Failed to update category.")
    }finally{
      await client.release()
    }
  }

  async remove(user_id:string, category_id: string) {
    const client = await this.pgPool.connect()
    try{
      const result = await client.query(`
        UPDATE categories
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id, user_id, name, deleted_at, updated_at, sync_version
        `, [user_id, category_id])
      if (!result.rowCount) {
        throw new BadRequestException('Category not found.')
      }
      return result.rows[0]
    }catch(error: any){
      if (error?.message?.includes('Category not found')) throw error
      throw new BadRequestException('Failed to delete category')
    }finally{
      await client.release()
    }
  }
}
