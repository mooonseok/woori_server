import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';
import { AdminApi } from './decorators/admin-api.decorator';
import {
  CurrentAdmin,
  RequireAdminReauth,
} from './decorators/admin-access.decorator';
import type { AdminSessionContext } from './dto/admin-session.dto';
import {
  AdminUserListDto,
  AdminUserParamsDto,
  AdminUserReasonDto,
  DeleteAdminUserDto,
  RenameAdminUserDto,
} from './dto/admin-members.dto';
// Member accounts (MFA-verified admin sessions). Suspension, unsuspension and
// deletion also need a recent re-authentication.
@AdminApi()
@Controller('v1/admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}
  @Get()
  list(@Query() query: AdminUserListDto) {
    return this.service.list(query);
  }
  @Get(':userId')
  detail(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminUserParamsDto
  ) {
    return this.service.view(session.admin.id, params.userId);
  }
  @Patch(':userId')
  rename(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminUserParamsDto,
    @Body() dto: RenameAdminUserDto
  ) {
    return this.service.rename(session.admin.id, params.userId, dto);
  }
  @RequireAdminReauth()
  @Post(':userId/suspend')
  @HttpCode(200)
  suspend(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminUserParamsDto,
    @Body() dto: AdminUserReasonDto
  ) {
    return this.service.suspend(session.admin.id, params.userId, dto.reason);
  }
  @RequireAdminReauth()
  @Post(':userId/unsuspend')
  @HttpCode(200)
  unsuspend(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminUserParamsDto,
    @Body() dto: AdminUserReasonDto
  ) {
    return this.service.unsuspend(session.admin.id, params.userId, dto.reason);
  }
  @RequireAdminReauth()
  @Post(':userId/delete')
  @HttpCode(200)
  delete(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminUserParamsDto,
    @Body() dto: DeleteAdminUserDto
  ) {
    return this.service.delete(session.admin.id, params.userId, dto);
  }
}
