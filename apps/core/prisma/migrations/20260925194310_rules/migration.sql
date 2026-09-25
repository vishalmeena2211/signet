-- CreateTable
CREATE TABLE "rules" (
    "id" UUID NOT NULL,
    "repo_label" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "trend" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "check_json" TEXT,
    "exceptions_json" TEXT NOT NULL DEFAULT '[]',
    "fp_count" INTEGER NOT NULL DEFAULT 0,
    "source_finding_kind" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_evidence" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "rule_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rules_repo_label_status_idx" ON "rules"("repo_label", "status");

-- CreateIndex
CREATE INDEX "rule_evidence_rule_id_idx" ON "rule_evidence"("rule_id");

-- AddForeignKey
ALTER TABLE "rule_evidence" ADD CONSTRAINT "rule_evidence_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
