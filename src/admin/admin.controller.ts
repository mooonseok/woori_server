import { All, Controller, ServiceUnavailableException } from '@nestjs/common';
@Controller(['v1/admin', 'api/v1/admin'])
export class AdminController {
  @All(['/', '*path']) pending(): never {
    throw new ServiceUnavailableException({ code: 'ADMIN_NOT_READY' });
  }
}
