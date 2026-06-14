import type { SignerRole } from "@prisma/client";
import { salesforce } from "./client.js";
import { isSalesforceId } from "./files.js";

/**
 * Read a Deal's record type and the Contacts on each party side, so signer routing can decide who
 * signs and resolve each role to a real person. Relationship/field names verified against the
 * target org (TTL_Core__Deal__c, API v60.0).
 */

export interface PartyContact {
  name: string;
  email: string;
}

export interface DealParties {
  recordType: string | null; // RecordType.DeveloperName, e.g. "Seller_Rep"
  contactsByRole: Partial<Record<SignerRole, PartyContact>>;
}

// role -> the Deal's lookup-to-Contact relationship name.
const ROLE_RELATIONSHIP: Partial<Record<SignerRole, string>> = {
  BUYER: "TTL_Core__Buyer_Contact__r",
  SELLER: "TTL_Core__Seller_Contact__r",
  TENANT: "TTL_Core__Tenant_Contact__r",
  LANDLORD: "TTL_Core__Landlord_Contact__r",
};

interface ContactRow {
  Name?: string | null;
  Email?: string | null;
}
interface DealRow {
  RecordType?: { DeveloperName?: string | null } | null;
  [rel: string]: unknown;
}

export interface DealDriveInfo {
  name: string;
  driveFolderUrl: string | null; // raw Deal_Files_Drive__c value, may be empty
}

/** Read a Deal's Name + its Google Drive folder link (Deal_Files_Drive__c). */
export async function getDealDriveInfo(recordId: string): Promise<DealDriveInfo> {
  if (!isSalesforceId(recordId)) throw new Error(`"${recordId}" is not a valid Salesforce record Id`);
  const soql = `SELECT Name, Deal_Files_Drive__c FROM TTL_Core__Deal__c WHERE Id = '${recordId}'`;
  const rows = await salesforce.query<{ Name?: string | null; Deal_Files_Drive__c?: string | null }>(soql);
  if (rows.length === 0) throw new Error(`Deal ${recordId} not found`);
  return { name: rows[0].Name ?? "Deal", driveFolderUrl: rows[0].Deal_Files_Drive__c ?? null };
}

/** Write a newly-created Drive folder URL back onto the Deal's Deal_Files_Drive__c field. */
export async function setDealDriveFolder(recordId: string, folderUrl: string): Promise<void> {
  if (!isSalesforceId(recordId)) throw new Error(`"${recordId}" is not a valid Salesforce record Id`);
  const conn = await salesforce.connection();
  const res = await conn.sobject("TTL_Core__Deal__c").update({ Id: recordId, Deal_Files_Drive__c: folderUrl });
  if (!res.success) {
    throw new Error(`Failed to set Deal_Files_Drive__c on ${recordId}: ${JSON.stringify(res.errors)}`);
  }
}

export async function getDealParties(recordId: string): Promise<DealParties> {
  if (!isSalesforceId(recordId)) throw new Error(`"${recordId}" is not a valid Salesforce record Id`);

  const rels = Object.values(ROLE_RELATIONSHIP);
  const selects = ["RecordType.DeveloperName", ...rels.flatMap((r) => [`${r}.Name`, `${r}.Email`])];
  const soql = `SELECT ${selects.join(", ")} FROM TTL_Core__Deal__c WHERE Id = '${recordId}'`;

  const rows = await salesforce.query<DealRow>(soql);
  if (rows.length === 0) throw new Error(`Deal ${recordId} not found`);
  const row = rows[0];

  const contactsByRole: Partial<Record<SignerRole, PartyContact>> = {};
  for (const [role, rel] of Object.entries(ROLE_RELATIONSHIP) as [SignerRole, string][]) {
    const c = row[rel] as ContactRow | null | undefined;
    // A party only counts if we have BOTH a name and an email to address the signing link to.
    if (c && c.Name && c.Email) contactsByRole[role] = { name: c.Name, email: c.Email };
  }

  return { recordType: row.RecordType?.DeveloperName ?? null, contactsByRole };
}
