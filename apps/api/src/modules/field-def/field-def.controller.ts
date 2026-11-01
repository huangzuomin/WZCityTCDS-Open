import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { FieldDefService } from './field-def.service';
import {
  createFieldDefSchema,
  listFieldDefQuerySchema,
  updateFieldDefSchema,
} from './field-def.dto';

@Controller('field-defs')
export class FieldDefController {
  constructor(private readonly service: FieldDefService) {}

  @Get()
  async list(@Query(new ZodValidationPipe(listFieldDefQuerySchema)) query: { categoryId?: number; resolved?: boolean }) {
    if (!query.categoryId) return { items: [] };
    const items = query.resolved
      ? await this.service.resolve(query.categoryId)
      : await this.service.listByCategory(query.categoryId);
    return { items, total: items.length };
  }

  /** 后台动态表单用它渲染 */
  @Get('resolved')
  resolved(@Query('categoryId', ParseIntPipe) categoryId: number) {
    return this.service.resolve(categoryId);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createFieldDefSchema)) dto: unknown) {
    return this.service.create(dto as never);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateFieldDefSchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
