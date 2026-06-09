-- CreateEnum
CREATE TYPE "SignerRole" AS ENUM ('BUYER', 'SELLER', 'TENANT', 'LANDLORD', 'OTHER');

-- AlterTable
ALTER TABLE "signers" ADD COLUMN     "role" "SignerRole";
