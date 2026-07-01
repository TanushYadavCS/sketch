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
 * True when `domain` is a known consumer webmail provider or a shared
 * SaaS/tooling domain — either way, not a company's corporate domain and never a
 * valid promotion target. Case-insensitive; trims surrounding whitespace.
 */
export function isPersonalOrSharedDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const normalized = domain.trim().toLowerCase();
  return PERSONAL_EMAIL_DOMAINS.has(normalized) || SHARED_DOMAINS.has(normalized);
}
