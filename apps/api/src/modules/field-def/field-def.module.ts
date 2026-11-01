import { Module } from '@nestjs/common';
import { CategoryModule } from '../category/category.module';
import { FieldDefController } from './field-def.controller';
import { FieldDefService } from './field-def.service';

@Module({
  imports: [CategoryModule],
  controllers: [FieldDefController],
  providers: [FieldDefService],
  exports: [FieldDefService],
})
export class FieldDefModule {}
