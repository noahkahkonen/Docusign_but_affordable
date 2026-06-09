import { describe, it, expect } from "vitest";
import { computeRouting } from "../src/signing/routing.js";

const buyer = { name: "Bob Buyer", email: "buyer@example.com" };
const seller = { name: "Sue Seller", email: "seller@example.com" };
const tenant = { name: "Tina Tenant", email: "tenant@example.com" };
const landlord = { name: "Lou Landlord", email: "landlord@example.com" };

const roles = (r: ReturnType<typeof computeRouting>) => r.signers.map((s) => s.role);

describe("signer routing", () => {
  it("Seller_Rep → seller + buyer when both parties are present", () => {
    const r = computeRouting({ recordType: "Seller_Rep", contactsByRole: { SELLER: seller, BUYER: buyer } });
    expect(roles(r)).toEqual(["SELLER", "BUYER"]);
    expect(r.missingRequired).toEqual([]);
  });

  it("Seller_Rep with an unrepresented/absent buyer → seller only", () => {
    const r = computeRouting({ recordType: "Seller_Rep", contactsByRole: { SELLER: seller } });
    expect(roles(r)).toEqual(["SELLER"]);
  });

  it("Seller_Rep missing the client (seller) contact → flags it as missingRequired", () => {
    const r = computeRouting({ recordType: "Seller_Rep", contactsByRole: { BUYER: buyer } });
    expect(roles(r)).toEqual(["BUYER"]);
    expect(r.missingRequired).toEqual(["SELLER"]);
  });

  it("Buyer_Rep → buyer only by default, even when a seller contact exists", () => {
    const r = computeRouting({ recordType: "Buyer_Rep", contactsByRole: { BUYER: buyer, SELLER: seller } });
    expect(roles(r)).toEqual(["BUYER"]);
  });

  it("Landlord_Rep → landlord + tenant when present", () => {
    const r = computeRouting({ recordType: "Landlord_Rep", contactsByRole: { LANDLORD: landlord, TENANT: tenant } });
    expect(roles(r)).toEqual(["LANDLORD", "TENANT"]);
  });

  it("an unconfigured record type applies no rule", () => {
    const r = computeRouting({ recordType: "Consulting", contactsByRole: { SELLER: seller } });
    expect(r.ruleApplied).toBe(false);
    expect(r.signers).toEqual([]);
  });
});
