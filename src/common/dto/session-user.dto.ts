import type { Request } from 'express';
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
}
export interface SessionRequest extends Request { user?: SessionUser; }
