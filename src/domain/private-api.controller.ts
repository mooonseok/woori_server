import { All, Controller, ServiceUnavailableException } from '@nestjs/common';
@Controller(['v1', 'api/v1'])
export class PrivateApiController {
  @All([
    'photos',
    'photos/*path',
    'uploads',
    'uploads/*path',
    'comments',
    'comments/*path',
    'notifications',
    'notifications/*path',
  ])
  pending(): never {
    throw new ServiceUnavailableException({ code: 'DOMAIN_NOT_READY' });
  }
}
