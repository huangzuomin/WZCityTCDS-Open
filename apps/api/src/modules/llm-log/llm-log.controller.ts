import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../auth/decorators';
import { LlmLogService } from './llm-log.service';

@Controller('llm-log')
export class LlmLogController {
  constructor(private readonly service: LlmLogService) {}

  @Get()
  @Roles('admin', 'editor')
  list(
    @Query('settingId') settingId?: string,
    @Query('purpose') purpose?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({
      settingId: settingId ? Number(settingId) : undefined,
      purpose,
      status,
      from,
      to,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Math.min(Number(pageSize), 200) : 20,
    });
  }

  @Get('stats')
  @Roles('admin', 'editor')
  stats(
    @Query('settingId') settingId?: string,
    @Query('purpose') purpose?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.stats({
      settingId: settingId ? Number(settingId) : undefined,
      purpose,
      status,
      from,
      to,
    });
  }
}
