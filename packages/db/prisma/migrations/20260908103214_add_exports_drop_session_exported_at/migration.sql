/*
  Warnings:

  - You are about to drop the column `exported_at` on the `sessions` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "sessions" DROP COLUMN "exported_at";

-- CreateTable
CREATE TABLE "exports" (
    "session_key" BIGINT NOT NULL,
    "exported_at" TIMESTAMP(3) NOT NULL,
    "path" TEXT NOT NULL,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("session_key")
);

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_session_key_fkey" FOREIGN KEY ("session_key") REFERENCES "sessions"("session_key") ON DELETE RESTRICT ON UPDATE CASCADE;
