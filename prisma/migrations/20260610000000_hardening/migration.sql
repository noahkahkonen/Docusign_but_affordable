-- Write-back idempotency: persist uploaded ContentDocumentIds so a retry after a partial
-- failure resumes instead of creating duplicate Files on the Salesforce record.
ALTER TABLE "signature_requests" ADD COLUMN "signed_content_document_id" TEXT;
ALTER TABLE "signature_requests" ADD COLUMN "certificate_content_document_id" TEXT;

-- Audit non-delivery of signing invitations (the legal trail must record "signer was never
-- notified", not just successes). PG12+ allows ADD VALUE in a transaction as long as the new
-- value isn't used within the same transaction (we only use it from app code afterwards).
ALTER TYPE "AuditEventType" ADD VALUE 'EMAIL_FAILED';

-- Bind templates to the geometry of the document they were built on, so AUTO-SEND can refuse
-- to apply a trusted template to a different document (page count/size mismatch).
ALTER TABLE "templates" ADD COLUMN "source_page_count" INTEGER;
ALTER TABLE "templates" ADD COLUMN "source_page_sizes" JSONB;
