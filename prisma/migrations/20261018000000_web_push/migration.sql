-- Existing installations must be explicitly rebound to a live browser session.
ALTER TABLE woori.push_installations ADD COLUMN "sessionId" uuid,
 ADD COLUMN "bindingVersion" integer NOT NULL DEFAULT 1,
 ADD COLUMN "boundAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "expiresAt" timestamptz(6),
 ADD CONSTRAINT "push_installations_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES woori.sessions(id) ON DELETE RESTRICT ON UPDATE CASCADE;
UPDATE woori.push_installations SET enabled=false, "revokedAt"=CURRENT_TIMESTAMP;
ALTER TABLE woori.notification_deliveries ADD COLUMN "bindingVersion" integer NOT NULL DEFAULT 1,
 ADD COLUMN "leaseToken" uuid, ADD COLUMN "resultCode" varchar(48);
CREATE INDEX "push_installations_sessionId_idx" ON woori.push_installations("sessionId");
