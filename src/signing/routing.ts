import type { SignerRole } from "@prisma/client";
import type { DealParties, PartyContact } from "../salesforce/deal.js";

/**
 * Signer routing: which parties sign a document, derived from the Deal's record type (= who the
 * agent represents). Roles resolve to real Contacts via the Deal's party fields.
 *
 * EDIT THIS MATRIX to change who signs. Each rule lists roles in signing order:
 *   - require: true  → your client; the request is incomplete if their Contact is missing.
 *   - require: false → the other side; included only if that Contact exists on the Deal
 *                      (covers "I represent the seller, the buyer is unrepresented, but I still
 *                       send them for signature").
 *
 * DEFAULTS (confirm with Noah): seller/landlord-rep deals send to BOTH sides; buyer/tenant-rep
 * deals send to the client only. To also send the other side on buyer/tenant rep, add an
 * { role: ..., require: false } entry below.
 */
export interface RoleRule {
  role: SignerRole;
  require: boolean;
}

export const ROUTING_RULES: Record<string, RoleRule[]> = {
  // Seller-side (sale): seller is the client; buyer signs too if present (even unrepresented).
  Seller_Rep: [{ role: "SELLER", require: true }, { role: "BUYER", require: false }],
  Disposition: [{ role: "SELLER", require: true }, { role: "BUYER", require: false }],
  // Landlord-side (lease): landlord is the client; tenant signs too if present.
  Landlord_Rep: [{ role: "LANDLORD", require: true }, { role: "TENANT", require: false }],
  // Buyer-side (sale): client only by default.
  Buyer_Rep: [{ role: "BUYER", require: true }],
  Investment_Sales: [{ role: "BUYER", require: true }],
  // Tenant-side (lease): client only by default.
  Tenant_Rep: [{ role: "TENANT", require: true }],
};

export interface RoutedSigner extends PartyContact {
  role: SignerRole;
}

export interface RoutingResult {
  recordType: string | null;
  ruleApplied: boolean; // false when the record type has no rule (unknown/unconfigured)
  signers: RoutedSigner[];
  missingRequired: SignerRole[]; // client roles whose Contact wasn't on the Deal
}

/** Apply the routing matrix to a Deal's parties. Pure — unit-testable without Salesforce. */
export function computeRouting(deal: DealParties): RoutingResult {
  const rule = deal.recordType ? ROUTING_RULES[deal.recordType] : undefined;
  if (!rule) {
    return { recordType: deal.recordType, ruleApplied: false, signers: [], missingRequired: [] };
  }

  const signers: RoutedSigner[] = [];
  const missingRequired: SignerRole[] = [];
  for (const { role, require } of rule) {
    const contact = deal.contactsByRole[role];
    if (contact) signers.push({ role, name: contact.name, email: contact.email });
    else if (require) missingRequired.push(role);
  }
  return { recordType: deal.recordType, ruleApplied: true, signers, missingRequired };
}
