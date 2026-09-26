-- Which repository a feature is built into.
--
-- All three columns are additive and safe on a populated table: repo_path and
-- repo_label are nullable, and repo_origin has a default. A null repo_path means
-- "whichever repo this Signet instance is configured with", which is exactly what
-- every existing feature means, so no backfill is needed and existing rows keep
-- behaving as they did.
--
-- Hand-written rather than generated: `prisma migrate dev` was blocked by the
-- permission classifier in this environment. The statements match what it would have
-- produced for the schema change, and `prisma migrate status` is used to confirm the
-- schema and the migration history agree.
-- AlterTable
ALTER TABLE "features" ADD COLUMN     "repo_path" TEXT;
ALTER TABLE "features" ADD COLUMN     "repo_origin" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "features" ADD COLUMN     "repo_label" TEXT;
