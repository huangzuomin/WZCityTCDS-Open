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
import { Public } from '../../auth/decorators';
import { CategoryService } from './category.service';
import {
  createCategorySchema,
  listCategoryQuerySchema,
  updateCategorySchema,
} from './category.dto';

@Controller('categories')
export class CategoryController {
  constructor(private readonly service: CategoryService) {}

  @Get()
  @Public()
  list(@Query(new ZodValidationPipe(listCategoryQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get(':id')
  @Public()
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  /** 从根到叶的继承链 */
  @Get(':id/chain')
  chain(@Param('id', ParseIntPipe) id: number) {
    return this.service.getChain(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createCategorySchema)) dto: unknown) {
    return this.service.create(dto as never);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateCategorySchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
