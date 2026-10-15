-- Explicit provisioning step after migration. Dedicated server-only login role must exist.
-- Never grant this role to Supabase anon/authenticated or use its password in the browser.
GRANT USAGE ON SCHEMA woori TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.users, woori.sessions, woori.email_tokens,
  woori.rate_limit_buckets, woori.groups, woori.memberships, woori.invitations TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.albums, woori.photos, woori.photo_variants, woori.media_cleanup_jobs TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.comments TO woori_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON woori.reactions TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.notifications, woori.notification_preferences, woori.group_notification_preferences TO woori_api;
GRANT SELECT, INSERT ON woori.notification_activities TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.push_installations, woori.notification_deliveries, woori.outbox_events TO woori_api;
GRANT SELECT, INSERT, UPDATE ON woori.photo_memory_preferences TO woori_api;
-- Members only read notices and submit/read inquiries. Notice authoring and inquiry
-- answers/status changes belong to the separately authenticated admin API: no UPDATE.
GRANT SELECT ON woori.notices TO woori_api;
GRANT SELECT, INSERT ON woori.inquiries TO woori_api;
-- Members file reports. The runtime role may only erase a withdrawing reporter's
-- detail (status changes belong to the admin role design). No DELETE: report rows
-- are retained. REVOKE first so re-applying this file removes any table-wide UPDATE.
GRANT SELECT, INSERT ON woori.content_reports TO woori_api;
REVOKE UPDATE ON woori.content_reports FROM woori_api;
GRANT UPDATE ("detail", "updatedAt") ON woori.content_reports TO woori_api;
-- Personal blocks: members add/remove their own rows; account withdrawal deletes
-- the withdrawing blocker's rows. No UPDATE: a block has no mutable state.
GRANT SELECT, INSERT, DELETE ON woori.user_blocks TO woori_api;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','email_tokens','rate_limit_buckets','groups','memberships','invitations','albums','photos','photo_variants','media_cleanup_jobs','comments','reactions','notifications','notification_preferences','group_notification_preferences','notification_activities','push_installations','notification_deliveries','outbox_events','photo_memory_preferences','notices','inquiries','content_reports','user_blocks'] LOOP
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
