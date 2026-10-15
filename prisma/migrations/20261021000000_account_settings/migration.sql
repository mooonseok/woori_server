-- Nullable target address is used only by CHANGE_EMAIL tokens. No existing token is changed.
ALTER TABLE "woori"."email_tokens" ADD COLUMN "targetEmail" VARCHAR(254);
