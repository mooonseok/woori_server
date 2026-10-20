// The source revision a release image was built from. scripts/release-image.mjs
// bakes it in as WOORI_RELEASE so an operator can match the running API or
// worker to a commit. Anything other than a full lowercase git SHA reads as
// unknown, so arbitrary environment text is never echoed back.
export function releaseRevision(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env.WOORI_RELEASE;
  return value && /^[0-9a-f]{40}$/.test(value) ? value : null;
}
