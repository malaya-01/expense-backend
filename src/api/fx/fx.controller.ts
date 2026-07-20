import { Controller, Get, Query, Res, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import {
  COUNTRIES,
  SUPPORTED_CURRENCIES,
  UNITS_PER_USD,
  convertAmount,
  getRate,
} from 'src/common/currency/currency.data';
import { Public } from 'src/helper/decorators/public.decorator';
import { errorResponse, successResponse } from 'src/utils/response/response';

@ApiTags('fx')
@Controller('fx')
export class FxController {
  @Public()
  @Get('meta')
  @ApiOperation({ summary: 'List supported countries and currencies' })
  meta(@Res() res: Response) {
    return res.status(HttpStatus.OK).send(
      successResponse(
        {
          countries: COUNTRIES,
          currencies: SUPPORTED_CURRENCIES,
          units_per_usd: UNITS_PER_USD,
        },
        'FX meta',
      ),
    );
  }

  @Public()
  @Get('rate')
  @ApiOperation({ summary: 'Get FX rate between two currencies' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  rate(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    try {
      const rate = getRate(from, to);
      return res
        .status(HttpStatus.OK)
        .send(successResponse({ from, to, rate }, 'FX rate'));
    } catch (error) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, HttpStatus.BAD_REQUEST, []));
    }
  }

  @Public()
  @Get('convert')
  @ApiOperation({ summary: 'Convert an amount between currencies' })
  @ApiQuery({ name: 'amount', required: true })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  convert(
    @Query('amount') amount: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    try {
      const value = Number(amount);
      if (!value || value <= 0) {
        throw new Error('Amount must be greater than zero');
      }
      const converted = convertAmount(value, from, to);
      const rate = getRate(from, to);
      return res.status(HttpStatus.OK).send(
        successResponse(
          { amount: value, from, to, rate, converted },
          'Converted',
        ),
      );
    } catch (error) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .send(errorResponse(error.message, HttpStatus.BAD_REQUEST, []));
    }
  }
}
