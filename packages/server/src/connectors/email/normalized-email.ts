export interface EmailAddr {
  email: string;
  name?: string;
}

export type EmailFolder = "inbox" | "sent";

export interface NormalizedEmail {
  providerMessageId: string;
  providerFileId: string;
  threadId: string | null;
  subject: string | null;
  sentAt: string | null;
  from: EmailAddr;
  to: EmailAddr[];
  cc: EmailAddr[];
  bcc: EmailAddr[];
  headers: ReadonlyMap<string, string>;
  bodyHtml: string | null;
  bodyText: string | null;
  providerUrl: string | null;
  ownerEmail: string | null;
  folder: EmailFolder;
}

export interface NormalizedEmailEnvelope {
  connectorConfigId: string;
  providerFileId: string;
  providerMessageId: string;
  threadId: string | null;
  subject: string | null;
  sentAt: string | null;
  from: EmailAddr;
  to: EmailAddr[];
  cc: EmailAddr[];
  ownerEmail: string | null;
  providerUrl: string | null;
}

export function normalizeEmailValue(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value?.includes("@") ? value : null;
}

export function normalizeEmailAddr(addr: EmailAddr): EmailAddr | null {
  const email = normalizeEmailValue(addr.email);
  if (!email) return null;
  const name = addr.name?.trim();
  return name ? { email, name } : { email };
}

export function normalizeEmailAddrs(addrs: EmailAddr[]): EmailAddr[] {
  const seen = new Set<string>();
  const result: EmailAddr[] = [];
  for (const addr of addrs) {
    const normalized = normalizeEmailAddr(addr);
    if (!normalized || seen.has(normalized.email)) continue;
    seen.add(normalized.email);
    result.push(normalized);
  }
  return result;
}

export function normalizeHeaderMap(headers: Iterable<[string, string | null | undefined]>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of headers) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = value?.trim();
    if (!normalizedKey || !normalizedValue) continue;
    result.set(normalizedKey, normalizedValue);
  }
  return result;
}

export function getHeader(headers: ReadonlyMap<string, string>, key: string): string | null {
  return headers.get(key.toLowerCase()) ?? null;
}

export function visibleParticipants(email: NormalizedEmail): EmailAddr[] {
  return normalizeEmailAddrs([email.from, ...email.to, ...email.cc]);
}

export function visibleParticipantEmails(email: NormalizedEmail): string[] {
  return visibleParticipants(email).map((participant) => participant.email);
}

export function emailEnvelope(connectorConfigId: string, email: NormalizedEmail): NormalizedEmailEnvelope {
  return {
    connectorConfigId,
    providerFileId: email.providerFileId,
    providerMessageId: email.providerMessageId,
    threadId: email.threadId,
    subject: email.subject,
    sentAt: email.sentAt,
    from: normalizeEmailAddr(email.from) ?? email.from,
    to: normalizeEmailAddrs(email.to),
    cc: normalizeEmailAddrs(email.cc),
    ownerEmail: normalizeEmailValue(email.ownerEmail),
    providerUrl: email.providerUrl,
  };
}
