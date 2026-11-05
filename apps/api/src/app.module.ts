import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { AuditModule } from './modules/audit/audit.module';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { AuditService } from './modules/audit/audit.service';
import { UserModule } from './modules/user/user.module';
import { DatasetModule } from './modules/dataset/dataset.module';
import { CategoryModule } from './modules/category/category.module';
import { FieldDefModule } from './modules/field-def/field-def.module';
import { EntityModule } from './modules/entity/entity.module';
import { ArticleModule } from './modules/article/article.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { FactModule } from './modules/fact/fact.module';
import { EventModule } from './modules/event/event.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { NewsModule } from './modules/news/news.module';
import { LlmConfigModule } from './modules/llm-config/llm-config.module';
import { LlmLogModule } from './modules/llm-log/llm-log.module';
import { ArchiveModule } from './modules/archive/archive.module';
import { GraphModule } from './modules/graph/graph.module';
import { HarvestModule } from './modules/harvest/harvest.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AcScanModule } from './modules/acscan/acscan.module';
import { ObservatoryModule } from './modules/observatory/observatory.module';
import { DevModule } from './modules/dev/dev.module';
import { McpModule } from './modules/mcp/mcp.module';
import { FactsAgentModule } from './modules/facts-agent/facts-agent.module';
import { OutletsModule } from './modules/outlets/outlets.module';
import { ReviewModule } from './modules/review/review.module';
import { HubSyncModule } from './modules/hub-sync/hub-sync.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    CommonModule,
    DbModule,
    AuthModule,
    AuditModule,
    UserModule,
    DatasetModule,
    CategoryModule,
    FieldDefModule,
    EntityModule,
    ArticleModule,
    EvidenceModule,
    FactModule,
    EventModule,
    PipelineModule,
    DiscoveryModule,
    NewsModule,
    LlmConfigModule,
    LlmLogModule,
    ArchiveModule,
    GraphModule,
    HarvestModule,
    DashboardModule,
    AcScanModule,
    ObservatoryModule,
    DevModule,
    McpModule,
    FactsAgentModule,
    OutletsModule,
    ReviewModule,
    HubSyncModule,
    HealthModule,
  ],
  providers: [
    // API 默认全量鉴权：@Public() 显式放开（展示层只读接口）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // 非 GET 写操作自动落 audit_log
    {
      provide: APP_INTERCEPTOR,
      inject: [Reflector, AuditService],
      useFactory: (reflector: Reflector, audit: AuditService) =>
        new AuditInterceptor(reflector, audit),
    },
  ],
})
export class AppModule {}
