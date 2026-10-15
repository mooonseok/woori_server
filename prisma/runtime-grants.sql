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
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','email_tokens','rate_limit_buckets','groups','memberships','invitations','albums','photos','photo_variants','media_cleanup_jobs','comments','reactions','notifications','notification_preferences','group_notification_preferences','notification_activities','push_installations','notification_deliveries','outbox_events','photo_memory_preferences'] LOOP
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
  woori.photo_memory_preferences TO woori_api;
