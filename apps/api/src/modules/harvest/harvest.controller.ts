import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { HarvestService } from './harvest.service';
import { z } from 'zod';

const taskCreateSchema = z.object({
  datasetId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(128),
  siteDomains: z.string().trim().min(1).max(255).default('66wz.com'),
  queriesPerEntity: z.coerce.number().int().min(1).max(10).default(3),
  applyMode: z.enum(['draft', 'auto']).default('draft'),
  intervalMinutes: z.coerce.number().int().min(5).max(100_000).default(1440),
  enabled: z.coerce.boolean().default(true),
});

const taskUpdateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  siteDomains: z.string().trim().min(1).max(255).optional(),
  queriesPerEntity: z.coerce.number().int().min(1).max(10).optional(),
  applyMode: z.enum(['draft', 'auto']).optional(),
  intervalMinutes: z.coerce.number().int().min(5).max(100_000).optional(),
  enabled: z.coerce.boolean().optional(),
});

@Controller('harvest')
export class HarvestController {
  constructor(private readonly service: HarvestService) {}

  // ---------------------------------------------------------------- 任务

  @Get('tasks')
  tasks(@Query('datasetId') datasetId?: string) {
    return this.service.listTasks(datasetId ? Number(datasetId) : undefined);
  }

  @Post('tasks')
  @Roles('admin', 'editor')
  create(@Body(new ZodValidationPipe(taskCreateSchema)) dto: unknown, @CurrentUser() user: CurrentUserPayload) {
    return this.service.createTask(dto as never, user?.id);
  }

  @Patch('tasks/:id')
  @Roles('admin', 'editor')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(taskUpdateSchema)) dto: unknown) {
    return this.service.updateTask(id, dto as never);
  }

  @Delete('tasks/:id')
  @Roles('admin')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteTask(id);
  }

  @Post('tasks/:id/run')
  @Roles('admin', 'editor')
  run(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: CurrentUserPayload) {
    return this.service.triggerRun(id, user?.id);
  }

  // ---------------------------------------------------------------- 运行记录

  @Get('runs')
  runs(
    @Query('taskId') taskId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listRuns(
      taskId ? Number(taskId) : undefined,
      page ? Number(page) : 1,
      pageSize ? Math.min(Number(pageSize), 100) : 20,
    );
  }

  @Get('runs/:id')
  runDetail(@Param('id', ParseIntPipe) id: number) {
    return this.service.getRun(id);
  }

  // ---------------------------------------------------------------- websearch token 配置

  @Get('config')
  config() {
    return this.service.getConfig();
  }

  @Put('config')
  @Roles('admin')
  saveConfig(@Body() body: { token: string }) {
    return this.service.saveToken(String(body?.token ?? ''));
  }

  @Post('config/test')
  @Roles('admin', 'editor')
  testConfig(@Body() body: { query?: string }) {
    return this.service.testToken(body?.query || '温州 瓯菜');
  }
}
