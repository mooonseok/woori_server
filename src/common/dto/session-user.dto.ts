import type { Request } from 'express';
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  nickname: string;
  nicknameNeedsUpdate: boolean;
  email: string;
  emailVerified: boolean;
  /** Profile photo version for /v1/users/{id}/avatar?v=, null without one. */
  avatarVersion: number | null;
}
export interface SessionRequest extends Request {
  user?: SessionUser;
}
