import type { Request } from 'express';
export interface AdminProfile {
  id: string;
  username: string;
  displayName: string;
}
export interface AdminSessionContext {
  sessionId: string;
  admin: AdminProfile;
  totpEnabled: boolean;
  mfaVerifiedAt: Date | null;
  reauthAt: Date | null;
  expiresAt: Date;
  idleExpiresAt: Date;
}
export interface AdminRequest extends Request {
  adminSession?: AdminSessionContext;
}
