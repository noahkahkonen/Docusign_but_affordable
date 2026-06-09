-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'COMPLETED', 'DECLINED', 'VOIDED');

-- CreateEnum
CREATE TYPE "SignerStatus" AS ENUM ('PENDING', 'VIEWED', 'CONSENTED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('EMAIL_LINK', 'EMAIL_OTP', 'SMS_OTP');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('SIGNATURE', 'INITIALS', 'DATE', 'TEXT');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('REQUEST_CREATED', 'REQUEST_SENT', 'EMAIL_DELIVERED', 'LINK_OPENED', 'CONSENT_GIVEN', 'DOCUMENT_VIEWED', 'FIELD_FILLED', 'SIGNED', 'DECLINED', 'COMPLETED', 'WRITEBACK_SUCCEEDED', 'WRITEBACK_FAILED', 'VOIDED');

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" UUID NOT NULL,
    "salesforce_record_id" TEXT NOT NULL,
    "salesforce_object_type" TEXT NOT NULL,
    "original_content_version_id" TEXT NOT NULL,
    "salesforce_request_record_id" TEXT,
    "document_name" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'DRAFT',
    "doc_hash_original" TEXT,
    "doc_hash_final" TEXT,
    "original_pdf" BYTEA,
    "signed_pdf" BYTEA,
    "certificate_pdf" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signers" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "entity_label" TEXT,
    "routing_order" INTEGER,
    "auth_method" "AuthMethod" NOT NULL DEFAULT 'EMAIL_LINK',
    "status" "SignerStatus" NOT NULL DEFAULT 'PENDING',
    "access_token_hash" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "consent_text" TEXT,
    "consent_version" TEXT,
    "consented_at" TIMESTAMP(3),
    "consent_ip" TEXT,
    "consent_user_agent" TEXT,
    "signed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fields" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "signer_id" UUID NOT NULL,
    "type" "FieldType" NOT NULL,
    "label" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "page_index" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "value" TEXT,

    CONSTRAINT "fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "signer_id" UUID,
    "event_type" "AuditEventType" NOT NULL,
    "auth_method" "AuthMethod",
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signature_requests_salesforce_record_id_idx" ON "signature_requests"("salesforce_record_id");

-- CreateIndex
CREATE INDEX "signature_requests_status_idx" ON "signature_requests"("status");

-- CreateIndex
CREATE INDEX "signers_request_id_idx" ON "signers"("request_id");

-- CreateIndex
CREATE INDEX "signers_access_token_hash_idx" ON "signers"("access_token_hash");

-- CreateIndex
CREATE INDEX "fields_request_id_idx" ON "fields"("request_id");

-- CreateIndex
CREATE INDEX "fields_signer_id_idx" ON "fields"("signer_id");

-- CreateIndex
CREATE INDEX "audit_events_request_id_idx" ON "audit_events"("request_id");

-- CreateIndex
CREATE INDEX "audit_events_signer_id_idx" ON "audit_events"("signer_id");

-- AddForeignKey
ALTER TABLE "signers" ADD CONSTRAINT "signers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "signers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "signers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

