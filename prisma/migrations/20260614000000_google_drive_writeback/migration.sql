-- Google Drive write-back: persist the deal folder + uploaded file ids for idempotency.
ALTER TABLE "signature_requests" ADD COLUMN "drive_folder_id" TEXT;
ALTER TABLE "signature_requests" ADD COLUMN "drive_signed_file_id" TEXT;
ALTER TABLE "signature_requests" ADD COLUMN "drive_certificate_file_id" TEXT;

-- Audit the Drive write-back outcome alongside the Salesforce one. PG12+ permits ADD VALUE in a
-- migration transaction as long as the new value isn't used within the same transaction.
ALTER TYPE "AuditEventType" ADD VALUE 'DRIVE_WRITEBACK_SUCCEEDED';
ALTER TYPE "AuditEventType" ADD VALUE 'DRIVE_WRITEBACK_FAILED';
