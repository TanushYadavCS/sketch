/**
 * ContactLine + SourceChip — the leaf that renders one contact point on a
 * People row: an icon by kind, the (masked) value, and a provenance chip.
 *
 * Contact points are built from the entity's real `metadata` today (see
 * {@link contactPointsFromMetadata}) — only emails the graph actually holds.
 * This component is the D1 swap point: when backend story D1 lands, feed it
 * `entity.contactPoints` from the API instead of the metadata-derived array.
 * D1 adds phone / WhatsApp points already server-masked (last digits only);
 * this leaf renders every kind unchanged, so only the producer swaps.
 */
import { EnvelopeIcon, PhoneIcon, WhatsappLogoIcon } from "@phosphor-icons/react";

export type OrgContactSource = "connector" | "signature" | "manual" | "crm";

export interface OrgContactPoint {
  kind: "email" | "phone" | "whatsapp";
  /** Masked for phone-like kinds, full for email — mirrors D1's serializer. */
  value: string;
  source: OrgContactSource;
}

const SOURCE_LABEL: Record<OrgContactSource, string> = {
  connector: "synced",
  signature: "signature",
  manual: "manual",
  crm: "CRM",
};

/**
 * Real contact points for a person, derived from `metadata`. Today the graph
 * only carries a synced email (`metadata.email`); phones / WhatsApp arrive with
 * D1. Returns an empty array when there is nothing real to show — the row then
 * renders its muted "No contact points" state rather than inventing anything.
 */
export function contactPointsFromMetadata(metadata: Record<string, unknown> | null): OrgContactPoint[] {
  const email = metadata?.email;
  if (typeof email === "string" && email.trim().length > 0) {
    return [{ kind: "email", value: email.trim(), source: "connector" }];
  }
  return [];
}

function SourceChip({ source }: { source: OrgContactSource }) {
  return (
    <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.05em] text-muted-foreground/70">
      {SOURCE_LABEL[source]}
    </span>
  );
}

export function ContactLine({ contact }: { contact: OrgContactPoint }) {
  const Icon = contact.kind === "email" ? EnvelopeIcon : contact.kind === "phone" ? PhoneIcon : WhatsappLogoIcon;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Icon
        size={12}
        weight={contact.kind === "whatsapp" ? "fill" : "regular"}
        aria-hidden
        className="shrink-0 text-muted-foreground/60"
      />
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{contact.value}</span>
      <SourceChip source={contact.source} />
    </div>
  );
}
