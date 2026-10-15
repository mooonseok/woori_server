-- Additive only: no row or constraint changes. Personal-block and account-deletion
-- erasure delete deliveries and push outbox events by notification id, and deleting
-- a notification runs the RESTRICT foreign-key check on notification_deliveries.
-- Without these indexes each of those statements scans the whole table.
-- CreateIndex
CREATE INDEX "notification_deliveries_notificationId_idx" ON "woori"."notification_deliveries"("notificationId");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateId_idx" ON "woori"."outbox_events"("aggregateId");
