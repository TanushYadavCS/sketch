/**
 * Canonical personal / shared email-provider domains, as CODE — the runtime
 * source of truth for "never promote this domain to a company".
 *
 * Background: the domain-promotion pipeline only skips personal providers when
 * `isPersonalOrShared(domain)` says so, and that check historically read solely
 * from `entity_domains` seed rows planted once by migration
 * `064-entity-domains-seed`. Any rebuild/purge that clears `entity_domains`
 * silently removed the guard, letting `gmail.com` mint a "Gmail" company. Keeping
 * the list in code makes the guard independent of mutable DB state; the DB seed
 * becomes a secondary, operator-visible copy.
 *
 * This list is the superset. Migration 064 carries an inline copy for the
 * initial seed and must be kept aligned with this file when either changes.
 */

export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
]);

export const SHARED_DOMAINS: ReadonlySet<string> = new Set([
  "googlegroups.com",
  "slack.com",
  "discord.com",
  "intercom.io",
  "hubspot.com",
  "salesforce.com",
  "atlassian.net",
  "notion.so",
  "linear.app",
  "clickup.com",
  "zoom.us",
]);

/**
 * Well-known SaaS / infra / notification-sender domains that are noise in a
 * typical org's client graph, not companies to promote (our own connector,
 * calendar/billing/notification senders, mega-consumer brands). Deliberately
 * kept SEPARATE from {@link SHARED_DOMAINS} — this set is consulted only by the
 * domain-promotion sweep, so it never widens the personal/shared guard that
 * affiliation and engagement callers read. Hard-coding the mega brands
 * (google/microsoft/amazon/…) is a single-deployment judgement call: if a tenant
 * ever has one of these as a real client, drop it from this one constant.
 */
export const WELL_KNOWN_NON_CLIENT_DOMAINS: ReadonlySet<string> = new Set([
  "fireflies.ai",
  "calendly.com",
  "docusign.com",
  "stripe.com",
  "aws.com",
  "amazonaws.com",
  "google.com",
  "microsoft.com",
  "amazon.com",
  "apple.com",
  "zomato.com",
]);

/**
 * True when `domain` — or any of its parent domains, on label boundaries — is in
 * `set`. `foo.linear.app` matches `linear.app`; `notlinear.app` does not. Skips
 * the bare TLD (checks suffixes down to the registrable pair only).
 */
function domainOrParentInSet(domain: string, set: ReadonlySet<string>): boolean {
  const labels = domain.split(".").filter(Boolean);
  for (let i = 0; i <= labels.length - 2; i++) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * True when `domain` is a known consumer webmail provider or a shared
 * SaaS/tooling domain — either way, not a company's corporate domain and never a
 * valid promotion target. Matches on label boundaries, so subdomains of a listed
 * domain (`oauthapp.linear.app`) are also caught. Case-insensitive; trims
 * surrounding whitespace and trailing dots.
 */
export function isPersonalOrSharedDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return domainOrParentInSet(normalized, PERSONAL_EMAIL_DOMAINS) || domainOrParentInSet(normalized, SHARED_DOMAINS);
}

/**
 * True when `domain` (or a parent, on label boundaries) is a well-known
 * non-client SaaS/infra/notification domain. Used ONLY by the domain-promotion
 * sweep to suppress vendor-noise company creation.
 */
export function isWellKnownNonClientDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return domainOrParentInSet(normalized, WELL_KNOWN_NON_CLIENT_DOMAINS);
}
