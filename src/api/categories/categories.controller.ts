import { Controller, Get, Post, Body, Patch, Param, Delete, Query, HttpStatus, Res, Req, BadRequestException } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ApiOperation, ApiBody, ApiResponse, ApiTags, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { Response } from 'express';

@ApiBearerAuth('bearer')
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new category' })
  @ApiBody({ type: CreateCategoryDto })
  @ApiResponse({ status: 201, description: 'Category created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(@Body() createCategoryDto: CreateCategoryDto, @Res() res: Response, @Req() req: Request ) {
    // return this.categoriesService.create(createCategoryDto);
    try{
      const userId = req['user'].id as string
      const result = await this.categoriesService.create(userId,createCategoryDto)
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode,[]))
    }
  }

  @Get()
  @ApiOperation({ summary: 'Get all the category' })
  // @ApiQuery({ name: 'user_id', type: String, required: true })
  async findAll(@Req() req: Request, @Res() res:Response) {
    // return this.categoriesService.findAll(user_id);
    try{
      const user_id = req['user'].id as string
      const result = await this.categoriesService.findAll(user_id)
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode,[]))
    }
  }

  @Get(':category_id')
  @ApiOperation({ summary: 'Find one category' })
  async findOne(@Req() req: Request, @Param('category_id') category_id: string, @Res() res: Response) {
    // return this.categoriesService.findOne(+id);
    try{
      const user_id = req['user'].id as string
      const result = await this.categoriesService.findOne(user_id, category_id)
      return res.status(HttpStatus.OK).send(successResponse(result, 'Category found'))

    }catch(error){
      const message = error.message || 'Something went wrong'
      const statusCode = error.statusCode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode, []))
    }
  }

  @Patch(':category_id')
  @ApiOperation({ summary: 'Update a category' })
  async update(@Req() req: Request, @Param('category_id') category_id:string, @Body() updateCategoryDto: UpdateCategoryDto, @Res() res:Response) {
    // return this.categoriesService.update(user_id, category_id, updateCategoryDto);
    try{
      const user_id = req['user'].id as string
      const result = await this.categoriesService.update(user_id, category_id, updateCategoryDto)
      return res.status(HttpStatus.OK).send(successResponse(result, 'Category updated.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode, []))
    }
  }

  @Delete(':category_id')
  @ApiOperation({
    description: 'Delete a category.'
  })
  remove(@Param('category_id') category_id: string , @Res() res: Response, @Req() req: Request) {
    try{
      const user_id = req['user'].id as string  
      const result = this.categoriesService.remove(user_id, category_id)
      return res.status(HttpStatus.OK).send(successResponse(result, 'cateogry deleted successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.status || error.statusCode || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode, []))
    }
  }


}
