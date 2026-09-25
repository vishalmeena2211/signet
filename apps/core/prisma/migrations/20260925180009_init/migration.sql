-- CreateTable
CREATE TABLE "features" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_versions" (
    "id" UUID NOT NULL,
    "feature_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content_md" TEXT NOT NULL,
    "frozen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "increments" (
    "id" UUID NOT NULL,
    "feature_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "state_json" TEXT NOT NULL,
    "declared_surface" TEXT[],
    "brief_version_id" UUID NOT NULL,
    "repair_attempt" INTEGER NOT NULL DEFAULT 0,
    "fresh_restarts" INTEGER NOT NULL DEFAULT 0,
    "order_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "increments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "increment_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "state_json" TEXT NOT NULL,
    "workspace_path" TEXT,
    "session_ref" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_phases" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "run_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "effect_journal" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "result_json" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "effect_journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_windows" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "exhausted_at" TIMESTAMP(3),
    "resets_at" TIMESTAMP(3),
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(10,6),
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_pack_manifests" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "manifest_json" TEXT NOT NULL,
    "pack_hash" TEXT NOT NULL,
    "assembled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_pack_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" UUID NOT NULL,
    "increment_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "state_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_verdicts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "gate" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "findings_json" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brief_versions_feature_id_version_key" ON "brief_versions"("feature_id", "version");

-- CreateIndex
CREATE INDEX "increments_feature_id_status_idx" ON "increments"("feature_id", "status");

-- CreateIndex
CREATE INDEX "runs_increment_id_status_idx" ON "runs"("increment_id", "status");

-- CreateIndex
CREATE INDEX "runs_status_idx" ON "runs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "run_phases_run_id_phase_attempt_key" ON "run_phases"("run_id", "phase", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "effect_journal_idempotency_key_key" ON "effect_journal"("idempotency_key");

-- CreateIndex
CREATE INDEX "effect_journal_run_id_status_idx" ON "effect_journal"("run_id", "status");

-- CreateIndex
CREATE INDEX "outbox_processed_at_available_at_idx" ON "outbox"("processed_at", "available_at");

-- CreateIndex
CREATE INDEX "quota_windows_kind_observed_at_idx" ON "quota_windows"("kind", "observed_at");

-- CreateIndex
CREATE INDEX "usage_ledger_run_id_idx" ON "usage_ledger"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "context_pack_manifests_run_id_key" ON "context_pack_manifests"("run_id");

-- CreateIndex
CREATE INDEX "escalations_increment_id_status_idx" ON "escalations"("increment_id", "status");

-- CreateIndex
CREATE INDEX "gate_verdicts_run_id_gate_idx" ON "gate_verdicts"("run_id", "gate");

-- AddForeignKey
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "increments" ADD CONSTRAINT "increments_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_increment_id_fkey" FOREIGN KEY ("increment_id") REFERENCES "increments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "effect_journal" ADD CONSTRAINT "effect_journal_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
