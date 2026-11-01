import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/** 全局公共能力：缓存（Redis 不可用时自动降级为内存） */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CommonModule {}
