/**
 * LEAF MOCK — placeholder contact points for the People tab.
 *
 * The contact-point read API (masking, provenance, source) is backend story D1
 * and is not built yet. This module fabricates a deterministic set of contact
 * points per person id so the People tab can be visually examined at real data
 * density. It is the single swap point: when D1 lands, replace
 * {@link mockContactPoints} with the real `entity.contactPoints` from
 * `GET /api/entities/:id` (or the batched list include) and delete this file.
 *
 * Values here are fake. Phone/WhatsApp values arrive from the server already
 * masked (last two digits); this mock mirrors that shape so the leaf component
 * renders identically once wired.
 */

export type OrgContactSource = "connector" | "signature" | "manual" | "crm";

export interface OrgContactPoint {
  kind: "email" | "phone" | "whatsapp";
  /** Masked for phone-like kinds, full for email — mirrors D1's serializer. */
  value: string;
  source: OrgContactSource;
}

const SOURCES: OrgContactSource[] = ["connector", "signature", "manual", "crm"];

/** Cheap deterministic hash so the same person always gets the same mock. */
function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function emailFrom(name: string, seed: number): string {
  const handle = name.trim().toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "") || "contact";
  const domains = ["acme.co", "meridian.partners", "example.com", "mail.co"];
  return `${handle}@${domains[seed % domains.length]}`;
}

function maskedPhone(seed: number): string {
  const last = String(seed % 100).padStart(2, "0");
  return `+91 ••••• ••${last}`;
}

/**
 * Deterministic placeholder contacts for a person. Roughly two thirds of people
 * get an email; a subset also get a masked phone/WhatsApp — enough variety to
 * exercise every icon and source chip in the leaf component.
 */
export function mockContactPoints(personId: string, name: string): OrgContactPoint[] {
  const seed = hash(personId);
  const points: OrgContactPoint[] = [];
  if (seed % 3 !== 0) {
    points.push({ kind: "email", value: emailFrom(name, seed), source: SOURCES[seed % SOURCES.length] });
  }
  if (seed % 4 === 0) {
    points.push({ kind: "phone", value: maskedPhone(seed), source: "connector" });
  } else if (seed % 5 === 0) {
    points.push({ kind: "whatsapp", value: maskedPhone(seed >> 2), source: "signature" });
  }
  return points;
}
