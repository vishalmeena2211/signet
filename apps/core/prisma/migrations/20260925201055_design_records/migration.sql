-- CreateTable
CREATE TABLE "design_records" (
    "id" UUID NOT NULL,
    "increment_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL,
    "intent_json" TEXT NOT NULL,
    "reference_image_path" TEXT,

    CONSTRAINT "design_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "design_records_increment_id_key" ON "design_records"("increment_id");
