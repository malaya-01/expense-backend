import { Inject, Injectable } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Client, Pool } from 'pg';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

@Injectable()
export class UserService {

  constructor(
    @Inject('PG_POOL') private readonly pgPool: Pool,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ){}

  async syncUsersToCache() {
    const cacheKey = 'all_users';
    const users = await this.pgPool.query(`SELECT id FROM users WHERE is_delete = false AND is_active = true`);
    await this.cacheManager.set(cacheKey, users.rows)
    console.log('Users synced to cache successfully', await this.cacheManager.get(cacheKey))
    return users.rows

  }
  create(createUserDto: CreateUserDto) {
    return 'This action adds a new user';
  }


  async findAll() {
    const client = await this.pgPool.connect()

    try{
      const allUsers = await client.query(`SELECT * FROM users WHERE is_delete = false AND is_active = true`)
      return allUsers.rows;
    }
    catch(error: any){
      throw new Error(error.message || 'Failed to fetch users')
    }
    finally{
      client.release()
    }
  }

  findOne(id: number) {
    return `This action returns a #${id} user`;
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
