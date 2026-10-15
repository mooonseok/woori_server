import { BadRequestException, NotFoundException } from '@nestjs/common';
// Admin-realm error helpers. Codes are part of the OpenAPI contract.
export function adminNotFound(code: string, message: string): never {
  throw new NotFoundException({ code, message });
}
// Admin list cursors anchor on an existing row id. A missing anchor (never
// existed, or the row was erased) means "restart from the first page".
export function adminCursorInvalid(code: string): never {
  throw new BadRequestException({
    code,
    message: '목록을 처음부터 다시 불러와 주세요.',
  });
}
