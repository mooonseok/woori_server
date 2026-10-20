// Public profile photo of a member as API responses expose it: the version to
// put in the avatar URL (/v1/users/{id}/avatar?v=...), or null without one.
export interface AvatarColumns {
  avatarKey: string | null;
  avatarVersion: number;
}
export const avatarColumns = { avatarKey: true, avatarVersion: true } as const;
export const avatarVersionOf = (user: AvatarColumns): number | null =>
  user.avatarKey ? user.avatarVersion : null;
