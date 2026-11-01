import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { Roles } from '../../auth/decorators';
import { UserService } from './user.service';
import { createUserSchema, listUserQuerySchema, updateUserSchema } from './user.dto';

@Controller('users')
@Roles('admin')
export class UserController {
  constructor(private readonly service: UserService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listUserQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createUserSchema)) dto: unknown) {
    return this.service.create(dto as never);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateUserSchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
