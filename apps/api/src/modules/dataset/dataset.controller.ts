import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { Public } from '../../auth/decorators';
import { DatasetService } from './dataset.service';
import {
  createDatasetSchema,
  listDatasetQuerySchema,
  syncDatasetCategoriesSchema,
  updateDatasetSchema,
} from './dataset.dto';

@Controller('datasets')
export class DatasetController {
  constructor(private readonly service: DatasetService) {}

  @Get()
  @Public()
  list(@Query(new ZodValidationPipe(listDatasetQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get(':id')
  @Public()
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Get(':id/stats')
  @Public()
  stats(@Param('id', ParseIntPipe) id: number) {
    return this.service.stats(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createDatasetSchema)) dto: unknown) {
    return this.service.create(dto as never);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateDatasetSchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  // ---------------------------------------------------------------- 关联分类（v2 dataset_category）

  @Get(':id/categories')
  linkedCategories(@Param('id', ParseIntPipe) id: number) {
    return this.service.linkedCategories(id);
  }

  /** 批量同步：整表 diff（新增/删除/更新一次提交，前端「保存」按钮调用） */
  @Put(':id/categories')
  syncCategories(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(syncDatasetCategoriesSchema)) dto: unknown,
  ) {
    return this.service.syncCategories(id, dto as never);
  }

  @Post(':id/categories/:categoryId')
  linkCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() body: { dimIds?: number[] },
  ) {
    return this.service.linkCategory(id, categoryId, body?.dimIds ?? null);
  }

  @Patch(':id/categories/:categoryId')
  updateLinkedCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() body: { dimIds?: number[]; sort?: number },
  ) {
    return this.service.updateLinkedCategory(id, categoryId, body ?? {});
  }

  @Delete(':id/categories/:categoryId')
  unlinkCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
  ) {
    return this.service.unlinkCategory(id, categoryId);
  }
}
