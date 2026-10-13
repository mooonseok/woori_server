import { SetMetadata } from '@nestjs/common';
export const PUBLIC_ROUTE = Symbol('public-route');
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
