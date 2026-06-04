import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import type { GeminiGenerator } from "../gemini-generate";
import { parseEmailAddrJson, parseEmailAddrListJson } from "./envelope-metadata";
import type { EmailAddr } from "./normalized-email";

const SEED_MAX_MESSAGES = 16;
const SEED_MAX_CHARS_PER_MESSAGE = 900;
const REDUCE_MAX_SUMMARIES = 40;

interface ThreadMessageRow {
  indexed_file_id: string;
  subject: string | null;
  sent_at: string | null;
  from_json: string;
  to_json: string;
  cc_json: string;
  content: string | null;
  content_hash: string | null;
  summary: string | null;
  summary_status: string;
}

interface ThreadSummaryBasis {
  summary: string;
  messageCount: number;
  basisFirstSentAt: string | null;
  basisLastSentAt: string | null;
  basisHash: string;
}

interface ReducedSummaryBasis {
  messageCount: number;
  basisFirstSentAt: string | null;
  basisLastSentAt: string | null;
  basisHash: string;
  promptRows: ThreadMessageRow[];
  olderContext: string | null;
}

function formatAddr(addr: EmailAddr): string {
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

function formatAddrList(addrs: EmailAddr[]): string {
  return addrs.map(formatAddr).join(", ");
}

function sortThreadRows<T extends { sent_at: string | null; indexed_file_id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.sent_at && b.sent_at && a.sent_at !== b.sent_at) return a.sent_at.localeCompare(b.sent_at);
    if (a.sent_at && !b.sent_at) return -1;
    if (!a.sent_at && b.sent_at) return 1;
    return a.indexed_file_id.localeCompare(b.indexed_file_id);
  });
}

function basisHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function loadThreadRows(
  db: Kysely<DB>,
  connectorConfigId: string,
  threadId: string,
): Promise<ThreadMessageRow[]> {
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
      "indexed_files.content_hash",
      "indexed_files.summary",
      "indexed_files.summary_status",
    ])
    .where("email_message_envelopes.connector_config_id", "=", connectorConfigId)
    .where("email_message_envelopes.thread_id", "=", threadId)
    .where("indexed_files.is_archived", "=", 0)
    .execute();
  return sortThreadRows(rows);
}

function renderSeedMessage(row: ThreadMessageRow): string {
  const from = formatAddr(parseEmailAddrJson(row.from_json));
  const to = formatAddrList(parseEmailAddrListJson(row.to_json));
  const cc = formatAddrList(parseEmailAddrListJson(row.cc_json));
  const header = [
    row.sent_at ? `Date: ${row.sent_at}` : null,
    `From: ${from}`,
    to ? `To: ${to}` : null,
    cc ? `Cc: ${cc}` : null,
    row.subject ? `Subject: ${row.subject}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const excerpt = (row.content ?? "").slice(0, SEED_MAX_CHARS_PER_MESSAGE).trim();
  return `${header}\n\n${excerpt}`.trim();
}

async function buildSeedSummary(
  generator: GeminiGenerator,
  connectorConfigId: string,
  threadId: string,
  rows: ThreadMessageRow[],
): Promise<ThreadSummaryBasis | null> {
  if (rows.length === 0) return null;
  const included = rows.slice(-SEED_MAX_MESSAGES);
  const prompt = `Build a concise thread context summary from these currently indexed email messages.
Focus on topic, participants, project/company names, decisions, unresolved asks.
Do not summarize each message separately.

<messages>
${included.map(renderSeedMessage).join("\n\n---\n\n")}
</messages>`;
  const summary = (await generator.generate(prompt, { maxTokens: 512, label: `seedEmailThread:${threadId}` })).trim();
  return {
    summary,
    messageCount: rows.length,
    basisFirstSentAt: rows[0]?.sent_at ?? null,
    basisLastSentAt: rows[rows.length - 1]?.sent_at ?? null,
    basisHash: basisHash({
      mode: "seed",
      connectorConfigId,
      threadId,
      rows: included.map((row) => ({
        id: row.indexed_file_id,
        sentAt: row.sent_at,
        contentHash: row.content_hash,
      })),
    }),
  };
}

function buildReducedSummaryBasis(
  connectorConfigId: string,
  threadId: string,
  rows: ThreadMessageRow[],
  existingSummary?: string | null,
): ReducedSummaryBasis | null {
  const summarizedRows = rows.filter((row) => row.summary_status === "done" && row.summary?.trim());
  if (summarizedRows.length === 0) return null;
  const hasOlderRows = summarizedRows.length > REDUCE_MAX_SUMMARIES;
  const promptRows = hasOlderRows && existingSummary ? summarizedRows.slice(-REDUCE_MAX_SUMMARIES) : summarizedRows;
  const olderContext = hasOlderRows && existingSummary ? existingSummary : null;
  return {
    messageCount: rows.length,
    basisFirstSentAt: rows[0]?.sent_at ?? null,
    basisLastSentAt: rows[rows.length - 1]?.sent_at ?? null,
    basisHash: basisHash({
      mode: "reduce",
      connectorConfigId,
      threadId,
      rows: summarizedRows.map((row) => ({
        id: row.indexed_file_id,
        sentAt: row.sent_at,
        summary: row.summary,
      })),
    }),
    promptRows,
    olderContext,
  };
}

async function buildReducedSummary(
  generator: GeminiGenerator,
  threadId: string,
  basis: ReducedSummaryBasis,
): Promise<ThreadSummaryBasis> {
  const olderContext = basis.olderContext ? `\n<older_context>\n${basis.olderContext}\n</older_context>\n` : "";
  const prompt = `Build a concise thread context summary from these per-message summaries in chronological order.
Focus on durable context needed to understand future replies: topic, participants, project/company names, decisions, unresolved asks.
${olderContext}

<message_summaries>
${basis.promptRows.map((row) => `Date: ${row.sent_at ?? "unknown"}\nSubject: ${row.subject ?? "(no subject)"}\nSummary: ${row.summary}`).join("\n\n---\n\n")}
</message_summaries>`;
  const summary = (await generator.generate(prompt, { maxTokens: 512, label: `reduceEmailThread:${threadId}` })).trim();
  return {
    summary,
    messageCount: basis.messageCount,
    basisFirstSentAt: basis.basisFirstSentAt,
    basisLastSentAt: basis.basisLastSentAt,
    basisHash: basis.basisHash,
  };
}

async function upsertThreadSummary(
  db: Kysely<DB>,
  connectorConfigId: string,
  threadId: string,
  basis: ThreadSummaryBasis,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await db
    .insertInto("email_thread_summaries")
    .values({
      connector_config_id: connectorConfigId,
      thread_id: threadId,
      summary: basis.summary,
      message_count: basis.messageCount,
      basis_first_sent_at: basis.basisFirstSentAt,
      basis_last_sent_at: basis.basisLastSentAt,
      basis_hash: basis.basisHash,
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.columns(["connector_config_id", "thread_id"]).doUpdateSet({
        summary: basis.summary,
        message_count: basis.messageCount,
        basis_first_sent_at: basis.basisFirstSentAt,
        basis_last_sent_at: basis.basisLastSentAt,
        basis_hash: basis.basisHash,
        updated_at: updatedAt,
      }),
    )
    .execute();
}

export async function getEmailThreadSummary(
  db: Kysely<DB>,
  connectorConfigId: string,
  threadId: string | null,
): Promise<string | null> {
  if (!threadId) return null;
  const row = await db
    .selectFrom("email_thread_summaries")
    .select("summary")
    .where("connector_config_id", "=", connectorConfigId)
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  return row?.summary ?? null;
}

export async function ensureEmailThreadSummary(
  db: Kysely<DB>,
  generator: GeminiGenerator,
  connectorConfigId: string,
  threadId: string | null,
): Promise<string | null> {
  if (!threadId) return null;
  const existing = await getEmailThreadSummary(db, connectorConfigId, threadId);
  if (existing) return existing;
  const rows = await loadThreadRows(db, connectorConfigId, threadId);
  if (rows.length <= 1) return null;
  const seed = await buildSeedSummary(generator, connectorConfigId, threadId, rows);
  if (!seed) return null;
  await upsertThreadSummary(db, connectorConfigId, threadId, seed);
  return seed.summary;
}

export async function rebuildEmailThreadSummary(
  db: Kysely<DB>,
  generator: GeminiGenerator,
  connectorConfigId: string,
  threadId: string,
): Promise<"rebuilt" | "skipped"> {
  const rows = await loadThreadRows(db, connectorConfigId, threadId);
  const existing = await db
    .selectFrom("email_thread_summaries")
    .select(["basis_hash", "summary"])
    .where("connector_config_id", "=", connectorConfigId)
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  const basis = buildReducedSummaryBasis(connectorConfigId, threadId, rows, existing?.summary ?? null);
  if (!basis) return "skipped";
  if (existing?.basis_hash === basis.basisHash) return "skipped";
  const summary = await buildReducedSummary(generator, threadId, basis);
  await upsertThreadSummary(db, connectorConfigId, threadId, summary);
  return "rebuilt";
}
