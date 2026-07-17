import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import type { DB, WhatsAppBackfillRangesTable, WhatsAppInboundEventsTable } from "../schema";

export const WHATSAPP_BACKFILL_EMPTY_CONNECTION_KEY = "000000000000:000000000000";

export type WhatsAppBackfillRangeKind = "initial" | "gap";
export type WhatsAppBackfillRangeStatus =
  | "awaiting_anchor"
  | "pending"
  | "claimed"
  | "in_flight"
  | "materializing"
  | "complete"
  | "exhausted";
export type WhatsAppBackfillTerminalStatus = "complete" | "exhausted";
export type WhatsAppBackfillRangeRow = Selectable<WhatsAppBackfillRangesTable>;
export type WhatsAppBackfillStagedEventRow = Selectable<WhatsAppInboundEventsTable>;
type BackfillDb = Kysely<DB> | Transaction<DB>;

export interface WhatsAppBackfillAnchor {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  providerTimestamp: string;
}

export interface WhatsAppBackfillRangeEnsureResult {
  row: WhatsAppBackfillRangeRow;
  created: boolean;
  adopted: number;
}

function rangeKey(kind: WhatsAppBackfillRangeKind, connectionKey: string): string {
  return kind === "initial" ? "initial" : `gap:${connectionKey}`;
}

function anchorValues(anchor: WhatsAppBackfillAnchor | null) {
  return {
    cursor_remote_jid: anchor?.remoteJid ?? null,
    cursor_message_id: anchor?.id ?? null,
    cursor_from_me: anchor ? (anchor.fromMe ? 1 : 0) : null,
    cursor_provider_timestamp: anchor?.providerTimestamp ?? null,
  };
}

function truncateError(error: string): string {
  return error.slice(0, 1024);
}

export function createWhatsAppBackfillRangeRepository(db: BackfillDb) {
  async function getById(id: string): Promise<WhatsAppBackfillRangeRow | undefined> {
    return db.selectFrom("whatsapp_backfill_ranges").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async function getByRequestSession(requestSessionId: string): Promise<WhatsAppBackfillRangeRow | undefined> {
    return db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("request_session_id", "=", requestSessionId)
      .where("status", "=", "in_flight")
      .executeTakeFirst();
  }

  async function findAnchor(
    groupJid: string,
    kind: WhatsAppBackfillRangeKind,
    connectionKey: string,
    liveStartMessageId?: number | null,
  ): Promise<WhatsAppBackfillAnchor | null> {
    const query = db
      .selectFrom("conversation_messages as message")
      .innerJoin("conversations as conversation", "conversation.id", "message.conversation_id")
      .select([
        "conversation.provider_conversation_id as remote_jid",
        "message.provider_message_id as provider_message_id",
        "message.provider_from_me as provider_from_me",
        "message.provider_timestamp as provider_timestamp",
      ])
      .where("conversation.platform", "=", "whatsapp")
      .where("conversation.kind", "=", "group")
      .where("conversation.provider_conversation_id", "=", groupJid)
      .where("message.provider_message_id", "is not", null)
      .where("message.provider_timestamp", "is not", null);

    const row =
      kind === "initial"
        ? liveStartMessageId == null
          ? null
          : ((await query.where("message.id", "=", liveStartMessageId).executeTakeFirst()) ??
            (await query
              .orderBy("message.effective_at", "asc")
              .orderBy("message.id", "asc")
              .limit(1)
              .executeTakeFirst()))
        : await query
            .where("message.connection_key", "=", connectionKey)
            .orderBy("message.effective_at", "asc")
            .orderBy("message.id", "asc")
            .limit(1)
            .executeTakeFirst();
    if (!row?.provider_message_id || !row.provider_timestamp) return null;
    return {
      remoteJid: row.remote_jid,
      id: row.provider_message_id,
      fromMe: row.provider_from_me === 1,
      providerTimestamp: row.provider_timestamp,
    };
  }

  async function adoptRange(range: WhatsAppBackfillRangeRow): Promise<number> {
    let update = db
      .updateTable("conversation_messages")
      .set({ backfill_range_id: range.id })
      .where("source", "=", "history")
      .where("backfill_range_id", "is", null)
      .where(
        "conversation_id",
        "in",
        db
          .selectFrom("conversations")
          .select("id")
          .where("platform", "=", "whatsapp")
          .where("kind", "=", "group")
          .where("provider_conversation_id", "=", range.group_jid),
      );
    update =
      range.kind === "initial"
        ? update.where("connection_key", "<=", range.connection_key)
        : update.where("connection_key", "=", range.connection_key);
    const result = await update.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async function ensureRange(input: {
    groupJid: string;
    kind: WhatsAppBackfillRangeKind;
    connectionKey: string;
    lowerBoundAt: string;
    upperBoundAt: string;
    anchor: WhatsAppBackfillAnchor | null;
    now: string;
  }): Promise<WhatsAppBackfillRangeEnsureResult> {
    const id = randomUUID();
    const insert = await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id,
        group_jid: input.groupJid,
        range_key: rangeKey(input.kind, input.connectionKey),
        kind: input.kind,
        connection_key: input.connectionKey,
        status: input.anchor ? "pending" : "awaiting_anchor",
        lower_bound_at: input.lowerBoundAt,
        upper_bound_at: input.upperBoundAt,
        ...anchorValues(input.anchor),
        next_retry_at: input.anchor ? input.now : null,
        updated_at: input.now,
      })
      .onConflict((oc) => oc.columns(["group_jid", "range_key"]).doNothing())
      .executeTakeFirst();
    const created = Number(insert.numInsertedOrUpdatedRows ?? 0) > 0;
    let row = await db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("group_jid", "=", input.groupJid)
      .where("range_key", "=", rangeKey(input.kind, input.connectionKey))
      .executeTakeFirstOrThrow();

    if (row.status === "awaiting_anchor" && input.anchor) {
      await db
        .updateTable("whatsapp_backfill_ranges")
        .set({ status: "pending", ...anchorValues(input.anchor), next_retry_at: input.now, updated_at: input.now })
        .where("id", "=", row.id)
        .where("status", "=", "awaiting_anchor")
        .execute();
      row = (await getById(row.id)) ?? row;
    }

    const adopted = await adoptRange(row);
    return { row, created, adopted };
  }

  async function ensureInitialRange(input: {
    groupJid: string;
    connectionKey: string | null;
    liveStartEffectiveAt: string;
    liveStartMessageId: number;
    lowerBoundAt: string;
    now: string;
  }): Promise<WhatsAppBackfillRangeEnsureResult> {
    const connectionKey = input.connectionKey ?? WHATSAPP_BACKFILL_EMPTY_CONNECTION_KEY;
    return ensureRange({
      groupJid: input.groupJid,
      kind: "initial",
      connectionKey,
      lowerBoundAt: input.lowerBoundAt,
      upperBoundAt: input.liveStartEffectiveAt,
      anchor: await findAnchor(input.groupJid, "initial", connectionKey, input.liveStartMessageId),
      now: input.now,
    });
  }

  async function ensureGapRange(input: {
    groupJid: string;
    connectionKey: string;
    lowerBoundAt: string;
    upperBoundAt: string;
    now: string;
  }): Promise<WhatsAppBackfillRangeEnsureResult> {
    return ensureRange({
      ...input,
      kind: "gap",
      anchor: await findAnchor(input.groupJid, "gap", input.connectionKey),
    });
  }

  async function refreshAwaitingAnchors(now: string): Promise<number> {
    const ranges = await db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("status", "=", "awaiting_anchor")
      .orderBy("created_at", "asc")
      .execute();
    let refreshed = 0;
    for (const range of ranges) {
      const checkpoint =
        range.kind === "initial"
          ? await db
              .selectFrom("whatsapp_backfill_checkpoints")
              .select("live_start_message_id")
              .where("group_jid", "=", range.group_jid)
              .executeTakeFirst()
          : null;
      const anchor = await findAnchor(
        range.group_jid,
        range.kind as WhatsAppBackfillRangeKind,
        range.connection_key,
        checkpoint?.live_start_message_id,
      );
      if (!anchor) continue;
      const result = await db
        .updateTable("whatsapp_backfill_ranges")
        .set({ status: "pending", ...anchorValues(anchor), next_retry_at: now, updated_at: now })
        .where("id", "=", range.id)
        .where("status", "=", "awaiting_anchor")
        .executeTakeFirst();
      refreshed += Number(result.numUpdatedRows);
    }
    return refreshed;
  }

  async function claimNext(claimToken: string, now: string): Promise<WhatsAppBackfillRangeRow | undefined> {
    const inFlight = await db
      .selectFrom("whatsapp_backfill_ranges")
      .select("id")
      .where("status", "in", ["claimed", "in_flight"])
      .executeTakeFirst();
    if (inFlight) return undefined;

    const candidate = await db
      .selectFrom("whatsapp_backfill_ranges")
      .select("id")
      .where("status", "=", "pending")
      .where((eb) => eb.or([eb("next_retry_at", "is", null), eb("next_retry_at", "<=", now)]))
      .orderBy(sql`CASE WHEN last_served_at IS NULL THEN 0 ELSE 1 END`)
      .orderBy("last_served_at", "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .executeTakeFirst();
    if (!candidate) return undefined;
    const result = await db
      .updateTable("whatsapp_backfill_ranges")
      .set({ status: "claimed", claim_token: claimToken, claimed_at: now, updated_at: now })
      .where("id", "=", candidate.id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1 ? getById(candidate.id) : undefined;
  }

  async function markRequestAccepted(input: {
    rangeId: string;
    claimToken: string;
    requestSessionId: string;
    leaseGeneration: number;
    requestedAt: string;
    responseDeadlineAt: string;
  }): Promise<boolean> {
    const result = await db
      .updateTable("whatsapp_backfill_ranges")
      .set({
        status: "in_flight",
        request_session_id: input.requestSessionId,
        request_lease_generation: input.leaseGeneration,
        requested_at: input.requestedAt,
        response_deadline_at: input.responseDeadlineAt,
        attempts: sql`attempts + 1`,
        last_served_at: input.requestedAt,
        last_error: null,
        updated_at: input.requestedAt,
      })
      .where("id", "=", input.rangeId)
      .where("claim_token", "=", input.claimToken)
      .where("status", "=", "claimed")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async function releaseClaimAfterFailure(input: {
    rangeId: string;
    claimToken: string;
    error: string;
    nextRetryAt: string;
    now: string;
  }): Promise<boolean> {
    const result = await db
      .updateTable("whatsapp_backfill_ranges")
      .set({
        status: "pending",
        claim_token: null,
        claimed_at: null,
        next_retry_at: input.nextRetryAt,
        last_error: truncateError(input.error),
        updated_at: input.now,
      })
      .where("id", "=", input.rangeId)
      .where("claim_token", "=", input.claimToken)
      .where("status", "=", "claimed")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async function attachStagedEvents(requestSessionId: string, rangeId: string): Promise<number> {
    const result = await db
      .updateTable("whatsapp_inbound_events")
      .set({ backfill_range_id: rangeId })
      .where("request_session_id", "=", requestSessionId)
      .where("backfill_range_id", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async function listRequestEvents(requestSessionId: string): Promise<WhatsAppBackfillStagedEventRow[]> {
    return db
      .selectFrom("whatsapp_inbound_events")
      .selectAll()
      .where("request_session_id", "=", requestSessionId)
      .orderBy("chunk_index", "asc")
      .orderBy("id", "asc")
      .execute();
  }

  async function listRangeEvents(rangeId: string): Promise<WhatsAppBackfillStagedEventRow[]> {
    return db
      .selectFrom("whatsapp_inbound_events")
      .selectAll()
      .where("backfill_range_id", "=", rangeId)
      .orderBy("id", "asc")
      .execute();
  }

  async function applyReceivedPage(input: {
    rangeId: string;
    requestSessionId: string;
    oldest: WhatsAppBackfillAnchor | null;
    terminalStatus: WhatsAppBackfillTerminalStatus | null;
    now: string;
  }): Promise<boolean> {
    const nextStatus = input.terminalStatus ? "materializing" : "pending";
    const result = await db
      .updateTable("whatsapp_backfill_ranges")
      .set({
        status: nextStatus,
        ...(input.oldest ? anchorValues(input.oldest) : {}),
        attempts: 0,
        next_retry_at: input.terminalStatus ? null : input.now,
        claim_token: null,
        claimed_at: null,
        request_session_id: null,
        request_lease_generation: null,
        requested_at: null,
        response_deadline_at: null,
        terminal_status: input.terminalStatus,
        updated_at: input.now,
      })
      .where("id", "=", input.rangeId)
      .where("request_session_id", "=", input.requestSessionId)
      .where("status", "=", "in_flight")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async function listMaterializing(): Promise<WhatsAppBackfillRangeRow[]> {
    return db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("status", "=", "materializing")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
  }

  async function markMaterialized(rangeId: string, now: string): Promise<WhatsAppBackfillRangeRow | undefined> {
    await db
      .updateTable("whatsapp_backfill_ranges")
      .set({ status: sql`terminal_status`, updated_at: now })
      .where("id", "=", rangeId)
      .where("status", "=", "materializing")
      .where("terminal_status", "is not", null)
      .execute();
    return getById(rangeId);
  }

  async function deleteRangeStaging(rangeId: string): Promise<number> {
    const result = await db
      .deleteFrom("whatsapp_inbound_events")
      .where("backfill_range_id", "=", rangeId)
      .where("kind", "=", "history_batch")
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async function reclaimStale(input: {
    now: string;
    staleClaimBefore: string;
    leaseGeneration: number | null;
    maxAttempts: number;
    retryAt: string;
  }): Promise<{ claims: number; requests: number; exhausted: number }> {
    const claims = await db
      .updateTable("whatsapp_backfill_ranges")
      .set({
        status: "pending",
        claim_token: null,
        claimed_at: null,
        next_retry_at: input.retryAt,
        last_error: "stale claim reclaimed",
        updated_at: input.now,
      })
      .where("status", "=", "claimed")
      .where("claimed_at", "<", input.staleClaimBefore)
      .executeTakeFirst();

    const staleRequests = await db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("status", "=", "in_flight")
      .where((eb) =>
        eb.or([
          eb("response_deadline_at", "<=", input.now),
          ...(input.leaseGeneration === null ? [] : [eb("request_lease_generation", "!=", input.leaseGeneration)]),
        ]),
      )
      .execute();
    let requests = 0;
    let exhausted = 0;
    for (const range of staleRequests) {
      const leaseChanged = input.leaseGeneration !== null && range.request_lease_generation !== input.leaseGeneration;
      const terminal = !leaseChanged && range.attempts >= input.maxAttempts;
      const result = await db
        .updateTable("whatsapp_backfill_ranges")
        .set({
          status: terminal ? "materializing" : "pending",
          attempts: leaseChanged ? Math.max(0, range.attempts - 1) : range.attempts,
          next_retry_at: terminal ? null : input.retryAt,
          last_error: leaseChanged
            ? "gateway generation changed during history request"
            : "history response deadline expired",
          claim_token: null,
          claimed_at: null,
          request_session_id: null,
          request_lease_generation: null,
          requested_at: null,
          response_deadline_at: null,
          terminal_status: terminal ? "exhausted" : null,
          updated_at: input.now,
        })
        .where("id", "=", range.id)
        .where("status", "=", "in_flight")
        .where("request_session_id", "=", range.request_session_id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) continue;
      requests += 1;
      if (terminal) exhausted += 1;
    }
    return { claims: Number(claims.numUpdatedRows), requests, exhausted };
  }

  async function rearmExhausted(now: string, olderThan?: string): Promise<number> {
    let update = db
      .updateTable("whatsapp_backfill_ranges")
      .set({
        status: sql`CASE WHEN cursor_message_id IS NULL THEN 'awaiting_anchor' ELSE 'pending' END`,
        attempts: 0,
        next_retry_at: now,
        last_error: null,
        terminal_status: null,
        updated_at: now,
      })
      .where("status", "=", "exhausted");
    if (olderThan) update = update.where("updated_at", "<=", olderThan);
    const result = await update.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  return {
    getById,
    getByRequestSession,
    findAnchor,
    adoptRange,
    ensureInitialRange,
    ensureGapRange,
    refreshAwaitingAnchors,
    claimNext,
    markRequestAccepted,
    releaseClaimAfterFailure,
    attachStagedEvents,
    listRequestEvents,
    listRangeEvents,
    applyReceivedPage,
    listMaterializing,
    markMaterialized,
    deleteRangeStaging,
    reclaimStale,
    rearmExhausted,
  };
}
