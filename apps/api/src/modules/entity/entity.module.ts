import { Module } from '@nestjs/common';
import { CategoryModule } from '../category/category.module';
import { FieldDefModule } from '../field-def/field-def.module';
import { EntityController } from './entity.controller';
import { EntityService } from './entity.service';

@Module({
  imports: [CategoryModule, FieldDefModule],
  controllers: [EntityController],
  providers: [EntityService],
  exports: [EntityService],
})
export class EntityModule {}
