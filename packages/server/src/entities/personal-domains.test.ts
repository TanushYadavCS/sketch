import { describe, expect, it } from "vitest";
import { proposeCompanyNameFromDomain } from "../db/repositories/entity-domains";
import { isPersonalOrSharedDomain, isWellKnownNonClientDomain } from "./personal-domains";

describe("isPersonalOrSharedDomain — subdomain, label-boundary matching", () => {
  it("matches a subdomain of a listed shared domain, on label boundaries", () => {
    expect(isPersonalOrSharedDomain("linear.app")).toBe(true);
    expect(isPersonalOrSharedDomain("oauthapp.linear.app")).toBe(true);
    expect(isPersonalOrSharedDomain("foo.linear.app")).toBe(true);
    // Webmail subdomain too.
    expect(isPersonalOrSharedDomain("mail.gmail.com")).toBe(true);
  });

  it("does NOT match a same-suffix domain that only shares a substring (boundary safety)", () => {
    expect(isPersonalOrSharedDomain("notlinear.app")).toBe(false);
    expect(isPersonalOrSharedDomain("mygmail.com")).toBe(false);
    // A real corporate domain is never a subdomain of the sets.
    expect(isPersonalOrSharedDomain("habuild.in")).toBe(false);
    expect(isPersonalOrSharedDomain("oliverwyman.com")).toBe(false);
  });

  it("normalizes case / whitespace / trailing dot, and tolerates empties", () => {
    expect(isPersonalOrSharedDomain("  GMAIL.com. ")).toBe(true);
    expect(isPersonalOrSharedDomain(null)).toBe(false);
    expect(isPersonalOrSharedDomain("")).toBe(false);
  });
});

describe("isWellKnownNonClientDomain — vendor/infra suppression (sweep only)", () => {
  it("matches vendor domains and their notification subdomains", () => {
    expect(isWellKnownNonClientDomain("fireflies.ai")).toBe(true);
    expect(isWellKnownNonClientDomain("support.aws.com")).toBe(true);
    expect(isWellKnownNonClientDomain("xwf.google.com")).toBe(true);
    expect(isWellKnownNonClientDomain("stripe.com")).toBe(true);
  });

  it("leaves real corporate domains alone", () => {
    expect(isWellKnownNonClientDomain("habuild.in")).toBe(false);
    expect(isWellKnownNonClientDomain("oliverwyman.com")).toBe(false);
    expect(isWellKnownNonClientDomain(null)).toBe(false);
  });
});

describe("proposeCompanyNameFromDomain — registrable second-level label", () => {
  it("uses the label left of the public suffix, not the leftmost subdomain", () => {
    expect(proposeCompanyNameFromDomain("support.aws.com")).toBe("Aws");
    expect(proposeCompanyNameFromDomain("xwf.google.com")).toBe("Google");
    expect(proposeCompanyNameFromDomain("oauthapp.linear.app")).toBe("Linear");
  });

  it("handles compound ccTLD suffixes (SLD, not the suffix label)", () => {
    expect(proposeCompanyNameFromDomain("x.co.in")).toBe("X");
    expect(proposeCompanyNameFromDomain("icici.bank.in")).toBe("Icici");
    expect(proposeCompanyNameFromDomain("wilp.bits-pilani.ac.in")).toBe("Bits Pilani");
  });

  it("keeps simple corporate domains unchanged", () => {
    expect(proposeCompanyNameFromDomain("habuild.in")).toBe("Habuild");
    expect(proposeCompanyNameFromDomain("oliver-wyman.com")).toBe("Oliver Wyman");
    expect(proposeCompanyNameFromDomain("a.b.co.uk")).toBe("B");
  });

  it("refuses a bare public suffix (no registrable label) instead of minting a junk name", () => {
    // `co.in` is nothing but a compound public suffix — must NOT become "Co".
    expect(proposeCompanyNameFromDomain("co.in")).toBe("");
    expect(proposeCompanyNameFromDomain("co.uk.")).toBe("");
    // A single label (degenerate, not a real email domain) title-cases as-is.
    expect(proposeCompanyNameFromDomain("internal")).toBe("Internal");
  });
});
