-- Preserve nicknames chosen by members; only rename untouched generated values.
ALTER TABLE woori.users ALTER COLUMN nickname SET DEFAULT ('회원_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
UPDATE woori.users SET nickname = '회원_' || substr(nickname, 4)
WHERE "nicknameNeedsUpdate" = true AND nickname ~ '^가족_[a-f0-9]{8}$';
