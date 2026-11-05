import { Body, Controller, Get, Post } from '@nestjs/common';
import { Roles } from '../../auth/decorators';
import { HealthService } from './health.service';
import type {
  GoldenPathCandidateInput,
  SourceNewsDocumentSnapshot,
} from '@ssot/shared';

@Controller('health')
export class HealthController {
  constructor(private readonly service: HealthService) {}

  @Get()
  async getHealth() {
    return this.service.getHealthReport();
  }

  @Get('ready')
  async getReady() {
    return this.service.getReadiness();
  }

  @Get('live')
  async getLive() {
    return this.service.getLiveness();
  }

  @Post('e2e-run')
  @Roles('admin')
  async runE2E(
    @Body()
    params: {
      candidate: GoldenPathCandidateInput;
      sourceDoc: SourceNewsDocumentSnapshot;
      reviewerId: string;
    },
  ) {
    return this.service.runE2EAcceptance(params);
  }
}
