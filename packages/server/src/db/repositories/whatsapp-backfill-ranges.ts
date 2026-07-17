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

export interface WhatsAppBackfillGraphCandidate {
  range: WhatsAppBackfillRangeRow;
  conversationId: number;
  graphLastServedAt: string | null;
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
    accountJid?: string | null,
  ): Promise<WhatsAppBackfillAnchor | null> {
    const query = db
      .selectFrom("conversation_messages as message")
      .innerJoin("conversations as conversation", "conversation.id", "message.conversation_id")
      .select([
        "conversation.provider_conversation_id as remote_jid",
        "message.provider_message_id as provider_message_id",
        "message.provider_from_me as provider_from_me",
        "message.sender_jid as sender_jid",
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
      fromMe: row.provider_from_me === 1 || Boolean(accountJid && row.sender_jid === accountJid),
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
        sql<boolean>`EXISTS (
          SELECT 1
          FROM whatsapp_backfill_ranges AS target
          WHERE target.id = ${range.id}
            AND target.graph_completed_at IS NULL
            AND (
              (target.graph_cursor_effective_at IS NULL AND target.graph_cursor_message_id IS NULL)
              OR conversation_messages.effective_at > target.graph_cursor_effective_at
              OR (
                conversation_messages.effective_at = target.graph_cursor_effective_at
                AND conversation_messages.id > target.graph_cursor_message_id
              )
            )
        )`,
      )
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
    accountJid?: string | null;
  }): Promise<WhatsAppBackfillRangeEnsureResult> {
    const connectionKey = input.connectionKey ?? WHATSAPP_BACKFILL_EMPTY_CONNECTION_KEY;
    return ensureRange({
      groupJid: input.groupJid,
      kind: "initial",
      connectionKey,
      lowerBoundAt: input.lowerBoundAt,
      upperBoundAt: input.liveStartEffectiveAt,
      anchor: await findAnchor(input.groupJid, "initial", connectionKey, input.liveStartMessageId, input.accountJid),
      now: input.now,
    });
  }

  async function ensureGapRange(input: {
    groupJid: string;
    connectionKey: string;
    lowerBoundAt: string;
    upperBoundAt: string;
    now: string;
    accountJid?: string | null;
  }): Promise<WhatsAppBackfillRangeEnsureResult> {
    return ensureRange({
      ...input,
      kind: "gap",
      anchor: await findAnchor(input.groupJid, "gap", input.connectionKey, null, input.accountJid),
    });
  }

  async function refreshAwaitingAnchors(now: string, accountJid?: string | null): Promise<number> {
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
        accountJid,
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

  async function finalizeMaterialized(
    rangeId: string,
    now: string,
  ): Promise<{ range: WhatsAppBackfillRangeRow | undefined; stagedRowsDeleted: number }> {
    await db
      .updateTable("whatsapp_backfill_ranges")
      .set({ status: sql`terminal_status`, updated_at: now })
      .where("id", "=", rangeId)
      .where("status", "=", "materializing")
      .where("terminal_status", "is not", null)
      .execute();
    const range = await getById(rangeId);
    if (!range || (range.status !== "complete" && range.status !== "exhausted")) {
      return { range, stagedRowsDeleted: 0 };
    }
    const result = await db
      .deleteFrom("whatsapp_inbound_events")
      .where("backfill_range_id", "=", rangeId)
      .where("kind", "=", "history_batch")
      .executeTakeFirst();
    return { range, stagedRowsDeleted: Number(result.numDeletedRows) };
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
    let query = db.selectFrom("whatsapp_backfill_ranges").selectAll().where("status", "=", "exhausted");
    if (olderThan) query = query.where("updated_at", "<=", olderThan);
    const exhausted = await query.orderBy("created_at", "asc").orderBy("id", "asc").execute();
    let created = 0;
    for (const parent of exhausted) {
      const result = await db
        .insertInto("whatsapp_backfill_ranges")
        .values({
          id: randomUUID(),
          group_jid: parent.group_jid,
          range_key: `continuation:${parent.id}`,
          kind: "gap",
          connection_key: parent.connection_key,
          parent_range_id: parent.id,
          status: parent.cursor_message_id ? "pending" : "awaiting_anchor",
          lower_bound_at: parent.lower_bound_at,
          upper_bound_at: parent.upper_bound_at,
          cursor_remote_jid: parent.cursor_remote_jid,
          cursor_message_id: parent.cursor_message_id,
          cursor_from_me: parent.cursor_from_me,
          cursor_provider_timestamp: parent.cursor_provider_timestamp,
          attempts: 0,
          next_retry_at: parent.cursor_message_id ? now : null,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(["group_jid", "range_key"]).doNothing())
        .executeTakeFirst();
      created += Number(result.numInsertedOrUpdatedRows ?? 0) > 0 ? 1 : 0;
    }
    return created;
  }

  async function reconcileUnownedConnection(input: {
    groupJid: string;
    connectionKey: string;
    now: string;
  }): Promise<{ adopted: number; supplementalCreated: boolean }> {
    const allRanges = await db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("group_jid", "=", input.groupJid)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const ranges = allRanges.filter(
      (range) =>
        range.connection_key === input.connectionKey ||
        (range.kind === "initial" && input.connectionKey <= range.connection_key),
    );
    let adopted = 0;
    for (const range of ranges) adopted += await adoptRange(range);
    const orphan = await db
      .selectFrom("conversation_messages as message")
      .innerJoin("conversations as conversation", "conversation.id", "message.conversation_id")
      .select("message.id")
      .where("conversation.platform", "=", "whatsapp")
      .where("conversation.kind", "=", "group")
      .where("conversation.provider_conversation_id", "=", input.groupJid)
      .where("message.source", "=", "history")
      .where("message.backfill_range_id", "is", null)
      .where("message.connection_key", "=", input.connectionKey)
      .orderBy("message.id", "asc")
      .executeTakeFirst();
    if (!orphan || ranges.length === 0) return { adopted, supplementalCreated: false };
    const rangesById = new Map(ranges.map((range) => [range.id, range]));
    const depth = (range: WhatsAppBackfillRangeRow): number => {
      let value = 0;
      let parentRangeId = range.parent_range_id;
      const visited = new Set<string>();
      while (parentRangeId && !visited.has(parentRangeId)) {
        visited.add(parentRangeId);
        const parentRange = rangesById.get(parentRangeId);
        if (!parentRange) break;
        value += 1;
        parentRangeId = parentRange.parent_range_id;
      }
      return value;
    };
    const parent = [...ranges].sort((left, right) => depth(right) - depth(left) || left.id.localeCompare(right.id))[0];
    if (!parent) return { adopted, supplementalCreated: false };
    const insert = await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: randomUUID(),
        group_jid: input.groupJid,
        range_key: `supplemental:${parent.id}:${orphan.id}`,
        kind: "gap",
        connection_key: input.connectionKey,
        parent_range_id: parent.id,
        status: "complete",
        lower_bound_at: parent.lower_bound_at,
        upper_bound_at: parent.upper_bound_at,
        terminal_status: "complete",
        updated_at: input.now,
      })
      .onConflict((oc) => oc.columns(["group_jid", "range_key"]).doNothing())
      .executeTakeFirst();
    const supplemental = await db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("group_jid", "=", input.groupJid)
      .where("range_key", "=", `supplemental:${parent.id}:${orphan.id}`)
      .executeTakeFirstOrThrow();
    adopted += await adoptRange(supplemental);
    return { adopted, supplementalCreated: Number(insert.numInsertedOrUpdatedRows ?? 0) > 0 };
  }

  async function findNextGraphCandidate(input: {
    groupJids: string[];
    excludedGroupJids: string[];
  }): Promise<WhatsAppBackfillGraphCandidate | undefined> {
    if (input.groupJids.length === 0) return undefined;
    let query = db
      .selectFrom("whatsapp_backfill_ranges as range")
      .innerJoin("conversations as conversation", (join) =>
        join
          .onRef("conversation.provider_conversation_id", "=", "range.group_jid")
          .on("conversation.platform", "=", "whatsapp")
          .on("conversation.kind", "=", "group"),
      )
      .innerJoin("whatsapp_groups as group", "group.jid", "range.group_jid")
      .innerJoin("whatsapp_backfill_checkpoints as checkpoint", "checkpoint.group_jid", "range.group_jid")
      .selectAll("range")
      .select(["conversation.id as graph_conversation_id", "checkpoint.graph_last_served_at as graph_last_served_at"])
      .where("range.status", "in", ["complete", "exhausted"])
      .where("range.graph_completed_at", "is", null)
      .where(
        sql<boolean>`(
          range.parent_range_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM whatsapp_backfill_ranges AS parent
            WHERE parent.id = range.parent_range_id
              AND parent.graph_completed_at IS NOT NULL
          )
        )`,
      )
      .where("checkpoint.graph_halted_at", "is", null)
      .where("group.index_enabled", "=", 1)
      .where("range.group_jid", "in", input.groupJids)
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM whatsapp_backfill_ranges AS older
          WHERE older.group_jid = range.group_jid
            AND older.graph_completed_at IS NULL
            AND (
              older.lower_bound_at < range.lower_bound_at
              OR (older.lower_bound_at = range.lower_bound_at AND older.upper_bound_at < range.upper_bound_at)
              OR (
                older.lower_bound_at = range.lower_bound_at
                AND older.upper_bound_at = range.upper_bound_at
                AND older.created_at < range.created_at
              )
              OR (
                older.lower_bound_at = range.lower_bound_at
                AND older.upper_bound_at = range.upper_bound_at
                AND older.created_at = range.created_at
                AND older.id < range.id
              )
            )
        )`,
      );
    if (input.excludedGroupJids.length > 0) {
      query = query.where("range.group_jid", "not in", input.excludedGroupJids);
    }
    const row = await query
      .orderBy(sql`CASE WHEN checkpoint.graph_last_served_at IS NULL THEN 0 ELSE 1 END`)
      .orderBy("checkpoint.graph_last_served_at", "asc")
      .orderBy("range.group_jid", "asc")
      .orderBy("range.lower_bound_at", "asc")
      .orderBy("range.upper_bound_at", "asc")
      .orderBy("range.created_at", "asc")
      .orderBy("range.id", "asc")
      .executeTakeFirst();
    if (!row) return undefined;
    const { graph_conversation_id, graph_last_served_at, ...range } = row;
    return {
      range: range as WhatsAppBackfillRangeRow,
      conversationId: graph_conversation_id,
      graphLastServedAt: graph_last_served_at,
    };
  }

  async function haltGraphAdmission(groupJid: string, reason: string, now: string): Promise<void> {
    await db
      .updateTable("whatsapp_backfill_checkpoints")
      .set({ graph_halted_at: now, graph_halt_reason: truncateError(reason), updated_at: now })
      .where("group_jid", "=", groupJid)
      .where("graph_halted_at", "is", null)
      .execute();
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
    finalizeMaterialized,
    reclaimStale,
    rearmExhausted,
    reconcileUnownedConnection,
    findNextGraphCandidate,
    haltGraphAdmission,
  };
}
