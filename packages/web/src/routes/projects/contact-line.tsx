/**
 * ContactLine + SourceChip — the leaf that renders one contact point on a
 * People row. Anatomy mirrors the prototype: an icon by kind, the (masked)
 * value, and a provenance chip. Fed by {@link mockContactPoints} today; swaps
 * to real D1 contact points with no change to this component.
 */
import { EnvelopeIcon, PhoneIcon, WhatsappLogoIcon } from "@phosphor-icons/react";
import type { OrgContactPoint, OrgContactSource } from "./org-contact-mock";

const SOURCE_LABEL: Record<OrgContactSource, string> = {
  connector: "synced",
  signature: "signature",
  manual: "manual",
  crm: "CRM",
};

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
