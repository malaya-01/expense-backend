import { Controller, Get, Post, Body, Patch, Param, Delete, Query, HttpStatus, Res } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ApiOperation, ApiBody, ApiResponse, ApiTags, ApiQuery } from '@nestjs/swagger';
import { errorResponse, successResponse } from 'src/utils/response/response';
import { Response } from 'express';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new category' })
  @ApiBody({ type: CreateCategoryDto })
  @ApiResponse({ status: 201, description: 'Category created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(@Body() createCategoryDto: CreateCategoryDto, @Res() res: Response) {
    // return this.categoriesService.create(createCategoryDto);
    try{
      const result = await this.categoriesService.create(createCategoryDto)
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }
  }

  @Get()
  @ApiOperation({ summary: 'Get all the category' })
  @ApiQuery({ name: 'user_id', type: String, required: true })
  async findAll(@Query('user_id') user_id: String, @Res() res:Response) {
    // return this.categoriesService.findAll(user_id);
    try{
      const result = await this.categoriesService.findAll(user_id)
      return res.status(HttpStatus.OK).send(successResponse(result, 'User loged in successfully.'))
    }catch(error){
      const message = error.message || 'An unexpected error occured'
      const statusCode = error.statuscode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }
  }

  @Get(':user_id/:category_id')
  @ApiOperation({ summary: 'Find one category' })
  async findOne(@Param('user_id') user_id:string, @Param('category_id') category_id: string, @Res() res: Response) {
    // return this.categoriesService.findOne(+id);
    try{
      const result = await this.categoriesService.findOne(user_id, category_id)
      return res.status(HttpStatus.OK).send(successResponse(result, 'Category found'))

    }catch(error){
      const message = error.message || 'Something went wrong'
      const statusCode = error.statusCode || error.status || HttpStatus.BAD_REQUEST
      return res.status(statusCode).send(errorResponse(message, statusCode))
    }
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCategoryDto: UpdateCategoryDto) {
    return this.categoriesService.update(+id, updateCategoryDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(+id);
  }
}
