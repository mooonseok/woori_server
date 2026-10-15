import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ADMIN_ROUTE } from '../../common/decorators/admin-route.decorator';
import { AdminSessionGuard } from '../guards/admin-session.guard';
// The admin-route marker and the admin guard are applied together, so a
// controller can never opt out of member authorization without admin checks.
export const AdminApi = () =>
  applyDecorators(SetMetadata(ADMIN_ROUTE, true), UseGuards(AdminSessionGuard));
