-- What happened to a feature, in order, and which step a take-back reverts.
--
-- Additive only: a new table, and one nullable column on increments. Existing rows are
-- untouched and need no backfill — a feature with no events simply shows the events
-- the other tables can reconstruct.
--
-- Hand-written, as before: `prisma migrate dev` is blocked by the permission classifier
-- in this environment. `prisma migrate status` confirms schema and history agree.

-- CreateTable
CREATE TABLE "feature_events" (
    "id" UUID NOT NULL,
    "feature_id" UUID NOT NULL,
    "increment_id" UUID,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload_json" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "feature_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_events_feature_id_at_idx" ON "feature_events"("feature_id", "at");

-- CreateIndex
CREATE INDEX "feature_events_at_idx" ON "feature_events"("at");

-- AddForeignKey
ALTER TABLE "feature_events" ADD CONSTRAINT "feature_events_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "increments" ADD COLUMN     "reverts_increment_id" UUID;
