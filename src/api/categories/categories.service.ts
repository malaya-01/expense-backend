import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Pool } from 'pg';

@Injectable()
export class CategoriesService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool
  ) { }

  async create(createCategoryDto: CreateCategoryDto) {
    const { user_id, name, description, color, icon, parent_id, is_system, budget_amount, budget_period } = createCategoryDto
    const client = await this.pgPool.connect()
    
    try {
      const existingCategory = await client.query(
        `SELECT id FROM categories WHERE name = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [name, user_id]
      )
      
      if (existingCategory.rowCount !== 0) {
        throw new BadRequestException('A category with this name already exists.')
      }

      const result = await client.query(
        `INSERT INTO categories (user_id, name, description, color, icon, parent_id, is_system, budget_amount, budget_period) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         RETURNING id, user_id, name, description, color, icon, parent_id, is_system, budget_amount, budget_period, created_at, updated_at`,
        [user_id, name, description || null, color || null, icon || null, parent_id || null, is_system || false, budget_amount || null, budget_period || null]
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

  async findAll(user_id: String) {
    const client = await this.pgPool.connect()
    try{
      const result = await client.query(`
        SELECT * FROM categories where user_id = $1
        `, [user_id])
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
    // return `This action updates a #${id} category`;
    const client = await this.pgPool.connect()

    try{
      const fields = Object.keys(updateCategoryDto)
      if (fields.length === 0){
        throw new BadRequestException('No values found to update.')
      }

      const setClause = fields.map((field, index)=>`${field} = $${index+1}`).join(', ');
      const values = Object.values(updateCategoryDto)
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

  remove(id: number) {
    return `This action removes a #${id} category`;
  }
}
