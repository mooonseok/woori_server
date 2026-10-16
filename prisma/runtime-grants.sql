-- Explicit provisioning step after migration. Dedicated server-only login role must exist.
-- Never grant this role to Supabase anon/authenticated or use its password in the browser.
GRANT USAGE ON SCHEMA woori TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.users, woori.sessions, woori.email_tokens,
  woori.rate_limit_buckets, woori.groups, woori.memberships, woori.invitations TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.albums, woori.photo_variants, woori.media_cleanup_jobs TO woori_api;
-- Photos/videos (W07-3): identity, owner, album, media kind, upload declaration
-- and creation time never change after insert. UPDATE is column-scoped to the
-- processing, capture-date, quota and deletion state the API/worker change.
-- REVOKE first so re-applying this file removes the earlier table-wide UPDATE.
GRANT SELECT, INSERT ON woori.photos TO woori_api;
REVOKE UPDATE ON woori.photos FROM woori_api;
GRANT UPDATE (status, bytes, width, height, "durationMs", "capturedAt",
  "captureDateSource", "manualCapturedDate", "captureMetadataCheckedAt",
  "reservedBytes", "processingToken", "processingUntil", "processingQueuedAt",
  "processingAvailableAt", "processingDeadlineAt", "processingAttempts",
  "processingErrorCode", "deletedAt") ON woori.photos TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.comments TO woori_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON woori.reactions TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.notification_preferences, woori.group_notification_preferences TO woori_api;
-- Notifications (W07 bundles): the runtime role only marks reads and allocates
-- the next bundle activity sequence; recipient, target, keys and the bundle
-- window never change after insert. Column-scoped UPDATE also covers the
-- FOR NO KEY UPDATE row locks bundling and erasure take. REVOKE first so
-- re-applying this file removes the earlier table-wide UPDATE.
GRANT SELECT, INSERT ON woori.notifications TO woori_api;
REVOKE UPDATE ON woori.notifications FROM woori_api;
GRANT UPDATE ("readThroughSequence", "lastSequence") ON woori.notifications TO woori_api;
-- Activities are immutable once recorded (DELETE below is erasure only).
GRANT SELECT, INSERT ON woori.notification_activities TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.push_installations, woori.notification_deliveries, woori.outbox_events TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.photo_memory_preferences TO woori_api;
-- Members only read notices and submit/read inquiries. Notice authoring and inquiry
-- answers/status changes happen only through the separately authenticated admin
-- API (MFA-verified admin session), so UPDATE is column-scoped to exactly those
-- fields. No DELETE on notices (no hard delete); inquiries keep the account
-- deletion DELETE below. REVOKE first so re-applying removes table-wide UPDATE.
GRANT SELECT, INSERT ON woori.notices TO woori_api;
REVOKE UPDATE ON woori.notices FROM woori_api;
GRANT UPDATE (title, body, status, "publishedAt", "updatedAt") ON woori.notices TO woori_api;
GRANT SELECT, INSERT ON woori.inquiries TO woori_api;
REVOKE UPDATE ON woori.inquiries FROM woori_api;
GRANT UPDATE (status, answer, "answeredAt", "updatedAt") ON woori.inquiries TO woori_api;
-- Members file reports. The runtime role may erase a withdrawing reporter's detail
-- and, for the admin API only, change processing state (status, resolvedAt,
-- resolution). Report identity, reporter, target and reason never change. No
-- DELETE: report rows are retained. REVOKE first so re-applying this file removes
-- any table-wide UPDATE.
GRANT SELECT, INSERT ON woori.content_reports TO woori_api;
REVOKE UPDATE ON woori.content_reports FROM woori_api;
GRANT UPDATE ("detail", "status", "resolvedAt", "resolution", "updatedAt") ON woori.content_reports TO woori_api;
-- Mail outbox (W07-4): rows are inserted with their token, then only the
-- delivery state changes (kind, user, token link, expiry and creation never do).
-- DELETE serves account-deletion erasure and the 14-day retention purge.
-- REVOKE first so re-applying this file removes any table-wide UPDATE.
GRANT SELECT, INSERT, DELETE ON woori.mail_outbox TO woori_api;
REVOKE UPDATE ON woori.mail_outbox FROM woori_api;
GRANT UPDATE (payload, status, attempts, "nextAttemptAt", "leaseUntil",
  "leaseToken", "resultCode", "sentAt") ON woori.mail_outbox TO woori_api;
-- Worker heartbeats: each process upserts its own row; stale rows are purged.
GRANT SELECT, INSERT, UPDATE, DELETE ON woori.worker_heartbeats TO woori_api;
-- Personal blocks: members add/remove their own rows; account withdrawal deletes
-- the withdrawing blocker's rows. No UPDATE: a block has no mutable state.
GRANT SELECT, INSERT, DELETE ON woori.user_blocks TO woori_api;
-- Service operator (admin) API. Accounts are created, disabled and MFA-reset only
-- by the owner-connection CLI: the runtime role never inserts or deletes accounts
-- and never changes username, display name, password or status. It may update only
-- login state (TOTP enrolment, replay step, failure counter, lockout, last login).
-- REVOKE first so re-applying this file removes any table-wide UPDATE.
GRANT SELECT ON woori.admin_accounts TO woori_api;
REVOKE INSERT, UPDATE, DELETE ON woori.admin_accounts FROM woori_api;
GRANT UPDATE ("totpSecretCiphertext", "totpEnabledAt", "totpLastUsedStep",
  "failedLoginCount", "lockedUntil", "lastLoginAt") ON woori.admin_accounts TO woori_api;
-- Admin sessions are revoked, never deleted. UPDATE is column-scoped to the
-- lifecycle columns the API changes (token rotation, MFA/re-auth times, idle
-- sliding, failure count, revocation); id, adminId and createdAt never change.
-- REVOKE first so re-applying this file removes a table-wide UPDATE.
GRANT SELECT, INSERT ON woori.admin_sessions TO woori_api;
REVOKE UPDATE ON woori.admin_sessions FROM woori_api;
GRANT UPDATE ("tokenHash", "expiresAt", "idleExpiresAt", "mfaVerifiedAt",
  "reauthAt", "mfaFailedCount", "revokedAt") ON woori.admin_sessions TO woori_api;
-- The admin audit log is append-only for the runtime role.
GRANT SELECT, INSERT ON woori.admin_audit_logs TO woori_api;
REVOKE UPDATE, DELETE ON woori.admin_audit_logs FROM woori_api;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','email_tokens','rate_limit_buckets','groups','memberships','invitations','albums','photos','photo_variants','media_cleanup_jobs','comments','reactions','notifications','notification_preferences','group_notification_preferences','notification_activities','push_installations','notification_deliveries','outbox_events','photo_memory_preferences','notices','inquiries','content_reports','user_blocks','admin_accounts','admin_sessions','admin_audit_logs','mail_outbox','worker_heartbeats'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='woori' AND tablename=t AND policyname='server_api_access') THEN
      EXECUTE format('CREATE POLICY server_api_access ON woori.%I FOR ALL TO woori_api USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;

-- Account withdrawal erases private records but keeps shared content identities.
GRANT DELETE ON woori.sessions, woori.email_tokens, woori.notifications,
  woori.notification_activities, woori.notification_preferences,
  woori.group_notification_preferences, woori.push_installations,
  woori.notification_deliveries, woori.outbox_events,
  woori.photo_memory_preferences, woori.inquiries TO woori_api;
