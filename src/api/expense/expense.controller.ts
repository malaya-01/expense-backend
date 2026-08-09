import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { RequirePermissions } from 'src/helper/decorators/permissions.decorator';

@RequirePermissions('expenses.access')
@Controller('expense')
export class ExpenseController {
  constructor(private readonly expenseService: ExpenseService) {}

  @Post()
  @RequirePermissions('expenses.create')
  create(@Body() createExpenseDto: CreateExpenseDto) {
    return this.expenseService.create(createExpenseDto);
  }

  @Get()
  @RequirePermissions('expenses.read')
  findAll() {
    return this.expenseService.findAll();
  }

  @Get(':id')
  @RequirePermissions('expenses.read')
  findOne(@Param('id') id: string) {
    return this.expenseService.findOne(+id);
  }

  @Patch(':id')
  @RequirePermissions('expenses.update')
  update(@Param('id') id: string, @Body() updateExpenseDto: UpdateExpenseDto) {
    return this.expenseService.update(+id, updateExpenseDto);
  }

  @Delete(':id')
  @RequirePermissions('expenses.delete')
  remove(@Param('id') id: string) {
    return this.expenseService.remove(+id);
  }
}
