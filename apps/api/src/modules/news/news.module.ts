import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';
import { NewsScheduleService } from './news-schedule.service';

@Module({
  imports: [DiscoveryModule],
  controllers: [NewsController],
  providers: [NewsService, NewsScheduleService],
  exports: [NewsService, NewsScheduleService],
})
export class NewsModule {}
