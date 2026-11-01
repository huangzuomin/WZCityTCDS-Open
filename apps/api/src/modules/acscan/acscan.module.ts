import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { AcScanController } from './acscan.controller';
import { AcScanService } from './acscan.service';

@Module({
  imports: [DbModule],
  controllers: [AcScanController],
  providers: [AcScanService],
})
export class AcScanModule {}
