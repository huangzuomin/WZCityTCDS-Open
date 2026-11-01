import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { Roles } from '../../auth/decorators';
import { AuditService } from './audit.service';

const querySchema = z.object({
  targetType: z.string().trim().max(64).optional(),
  targetId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(64).optional(),
  dateFrom: z.string().trim().max(32).optional(),
  dateTo: z.string().trim().max(32).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

@Controller('audit-logs')
@Roles('admin', 'reviewer')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get()
  list(@Query(new ZodValidationPipe(querySchema)) query: unknown) {
    return this.service.list(query as never);
  }
}
