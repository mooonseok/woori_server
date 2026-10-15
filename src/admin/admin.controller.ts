import { All, Controller, NotFoundException } from '@nestjs/common';
import { AdminApi } from './decorators/admin-api.decorator';
// Registered last in AdminModule: any other /v1/admin/** path is still behind
// the admin guard (503 → 401 → 403) and answers 404 to a verified admin.
@AdminApi()
@Controller(['v1/admin', 'api/v1/admin'])
export class AdminController {
  @All(['/', '*path']) notFound(): never {
    throw new NotFoundException({
      code: 'ADMIN_NOT_FOUND',
      message: '요청한 관리자 기능을 찾을 수 없어요.',
    });
  }
}
