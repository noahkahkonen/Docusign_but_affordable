-- AlterTable
ALTER TABLE "signature_requests" ADD COLUMN     "prepare_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "prepare_token_hash" TEXT;
