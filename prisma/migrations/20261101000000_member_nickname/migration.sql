-- Recovery names stay private; never backfill public nicknames from personal data.
ALTER TABLE woori.users ADD COLUMN nickname VARCHAR(20);
UPDATE woori.users SET nickname = CASE WHEN status = 'DELETED' THEN '탈퇴한 회원' ELSE '가족_' || substr(replace(id::text, '-', ''), 1, 8) END;
ALTER TABLE woori.users ALTER COLUMN nickname SET DEFAULT ('가족_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
ALTER TABLE woori.users ALTER COLUMN nickname SET NOT NULL;
ALTER TABLE woori.users ADD CONSTRAINT users_nickname_length CHECK (char_length(nickname) BETWEEN 2 AND 20);
ALTER TABLE woori.users ADD COLUMN "nicknameNeedsUpdate" BOOLEAN NOT NULL DEFAULT true;
UPDATE woori.users SET "nicknameNeedsUpdate" = false WHERE status = 'DELETED';
