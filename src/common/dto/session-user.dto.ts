import type { Request } from 'express';
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  nickname: string;
  nicknameNeedsUpdate: boolean;
  email: string;
  emailVerified: boolean;
}
export interface SessionRequest extends Request {
  user?: SessionUser;
}
