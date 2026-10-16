-- At most one waiting (PENDING or RUNNING) push delivery per notification and
-- installation, also when several worker replicas fan out events of the same
-- bundle at once (fanout inserts with ON CONFLICT DO NOTHING). Partial unique
-- index; Prisma's schema cannot express it, like photos_memory_month_idx.
--
-- Before W07-1 a pair could hold two waiting rows only after the installation
-- was re-bound (deliveryKey includes bindingVersion). A row with an older
-- binding can never be sent (dispatch rejects a binding mismatch), so the
-- newest binding (then id) is kept and older waiting duplicates are closed as
-- DONE 'superseded' instead of failing the index build. No row is deleted.
UPDATE "woori"."notification_deliveries" d
SET "status" = 'DONE', "resultCode" = 'superseded', "leaseToken" = NULL, "leaseUntil" = NULL
WHERE d."status" IN ('PENDING', 'RUNNING')
  AND EXISTS (
    SELECT 1 FROM "woori"."notification_deliveries" o
    WHERE o."notificationId" = d."notificationId"
      AND o."installationId" = d."installationId"
      AND o."status" IN ('PENDING', 'RUNNING')
      AND (o."bindingVersion", o."id") > (d."bindingVersion", d."id")
  );

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_one_waiting_idx"
ON "woori"."notification_deliveries" ("notificationId", "installationId")
WHERE "status" IN ('PENDING', 'RUNNING');
