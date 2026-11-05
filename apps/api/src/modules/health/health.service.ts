import { Injectable } from '@nestjs/common';
import {
  EndToEndIntegrationPipeline,
  SystemHealthEvaluator,
  type SystemHealthReport,
  type E2EPipelineResult,
  type GoldenPathCandidateInput,
  type SourceNewsDocumentSnapshot,
} from '@ssot/shared';

@Injectable()
export class HealthService {
  private readonly pipeline: EndToEndIntegrationPipeline;
  private readonly evaluator: SystemHealthEvaluator;

  constructor() {
    this.pipeline = new EndToEndIntegrationPipeline();
    this.evaluator = new SystemHealthEvaluator(this.pipeline);
  }

  public getHealthReport(): SystemHealthReport {
    return this.evaluator.evaluateHealth();
  }

  public getReadiness(): { ready: boolean; status: string } {
    const report = this.evaluator.evaluateHealth();
    return {
      ready: report.status !== 'UNHEALTHY',
      status: report.status,
    };
  }

  public getLiveness(): { live: boolean; uptime_seconds: number } {
    const report = this.evaluator.evaluateHealth();
    return {
      live: true,
      uptime_seconds: report.uptime_seconds,
    };
  }

  public async runE2EAcceptance(params: {
    candidate: GoldenPathCandidateInput;
    sourceDoc: SourceNewsDocumentSnapshot;
    reviewerId: string;
  }): Promise<E2EPipelineResult> {
    return this.pipeline.executeGoldenPath(params);
  }
}
