import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import { parseEmailAddrJson, parseEmailAddrListJson } from "./envelope-metadata";
import type { EmailAddr } from "./normalized-email";

export interface BuildEmailThreadContextOptions {
  connectorConfigId: string;
  threadId: string | null;
  targetFileId?: string;
  maxMessages?: number;
  maxChars?: number;
}

function formatAddr(addr: EmailAddr): string {
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

function formatAddrList(addrs: EmailAddr[]): string {
  return addrs.map(formatAddr).join(", ");
}

export async function buildEmailThreadContext(db: Kysely<DB>, opts: BuildEmailThreadContextOptions): Promise<string> {
  if (!opts.threadId) return "";
  const maxMessages = opts.maxMessages ?? 12;
  const maxChars = opts.maxChars ?? 6_000;
  const rows = await db
    .selectFrom("email_message_envelopes")
    .innerJoin("indexed_files", "indexed_files.id", "email_message_envelopes.indexed_file_id")
    .select([
      "email_message_envelopes.indexed_file_id",
      "email_message_envelopes.subject",
      "email_message_envelopes.sent_at",
      "email_message_envelopes.from_json",
      "email_message_envelopes.to_json",
      "email_message_envelopes.cc_json",
      "indexed_files.content",
    ])
    .where("email_message_envelopes.connector_config_id", "=", opts.connectorConfigId)
    .where("email_message_envelopes.thread_id", "=", opts.threadId)
    .orderBy("email_message_envelopes.sent_at", "asc")
    .limit(maxMessages)
    .execute();

  const parts: string[] = [];
  for (const row of rows) {
    const marker = row.indexed_file_id === opts.targetFileId ? " (current)" : "";
    const from = formatAddr(parseEmailAddrJson(row.from_json));
    const to = formatAddrList(parseEmailAddrListJson(row.to_json));
    const cc = formatAddrList(parseEmailAddrListJson(row.cc_json));
    const header = [
      `Message${marker}`,
      row.sent_at ? `Date: ${row.sent_at}` : null,
      `From: ${from}`,
      to ? `To: ${to}` : null,
      cc ? `Cc: ${cc}` : null,
      row.subject ? `Subject: ${row.subject}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    parts.push(`${header}\n\n${row.content ?? ""}`.trim());
  }

  const block = parts.join("\n\n---\n\n");
  return block.length > maxChars ? `${block.slice(0, maxChars).trimEnd()}\n[thread truncated]` : block;
}
