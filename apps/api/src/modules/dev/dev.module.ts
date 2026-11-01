import { Module } from '@nestjs/common';
import { DevController } from './dev.controller';
import { DevService } from './dev.service';

/** 开发调试模块：数据清理等运维操作（仅管理员） */
@Module({
  controllers: [DevController],
  providers: [DevService],
  exports: [DevService],
})
export class DevModule {}
