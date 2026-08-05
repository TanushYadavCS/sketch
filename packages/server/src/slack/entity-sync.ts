import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { type SlackUserProfile, upsertSlackPersonEntityInTransaction } from "../db/repositories/slack-entity-sync";
import type { DB, SlackSyncRunsTable, SlackUserSyncStateTable } from "../db/schema";
import type { Logger } from "../logger";
import type { SlackIndexingChannel, SlackIndexingPage, SlackIndexingUser } from "./indexing-facade";

const BACKFILL_TRIGGER_KEY = "backfill";
const INITIAL_STAGE = "users";
const CONVERSATIONS_STAGE = "conversations";
const COMPLETED_STAGE = "completed";
const RUN_STATUS_QUEUED = "queued";
const RUN_STATUS_RUNNING = "running";
const RUN_STATUS_FAILED = "failed";
const RUN_STATUS_ABORTED = "aborted";
const RUN_STATUS_COMPLETED = "completed";
const DEFAULT_USER_INFO_CAP = 1000;
const DEFAULT_STALE_RUN_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

export interface SlackEntitySyncConnection {
  botToken: string;
  teamId: string;
}

export interface SlackEntitySyncFacade {
  listUsersPage: (cursor?: string) => Promise<SlackIndexingPage<SlackIndexingUser>>;
  listChannelsPage: (cursor?: string) => Promise<SlackIndexingPage<SlackIndexingChannel>>;
  listChannelMembersPage: (channelId: string, cursor?: string) => Promise<SlackIndexingPage<string>>;
  getUserInfo: (userId: string) => Promise<SlackIndexingUser>;
}

export interface SlackEntitySyncLogger {
  info: Logger["info"];
  warn: Logger["warn"];
  error: Logger["error"];
}

export interface SlackEntitySyncDeps {
  db: Kysely<DB>;
  logger: SlackEntitySyncLogger;
  enabled: boolean;
  publicChannelsEnabled: boolean;
  userInfoCap?: number;
  staleRunMs?: number;
  heartbeatMs?: number;
  getActiveConnection: () => Promise<SlackEntitySyncConnection | null>;
  createFacade: (botToken: string) => SlackEntitySyncFacade;
  now?: () => string;
}

export interface SlackEntitySyncService {
  start: () => void;
  stop: () => Promise<void>;
  onConnectionActivated: (connection: SlackEntitySyncConnection) => void;
  enqueueBackfill: (connection: SlackEntitySyncConnection) => Promise<void>;
}

type SyncRun = Selectable<SlackSyncRunsTable>;
type PendingState = Selectable<SlackUserSyncStateTable>;
type RunPatch = Partial<{
  status: string;
  stage: string | null;
  heartbeat_at: string | null;
  users_cursor: string | null;
  conversations_cursor: string | null;
  members_cursor: string | null;
  current_channel_id: string | null;
  completed_at: string | null;
  error: string | null;
  updated_at: string;
}>;

type SkipReason = {
  channelId: string;
  reason: string;
};

type RunError = {
  kind?: string;
  code?: string;
  message?: string;
  skipReasons?: SkipReason[];
};

class TeamChangedError extends Error {
  constructor() {
    super("active Slack team changed during entity sync");
    this.name = "TeamChangedError";
  }
}

function isTeamChangedError(error: unknown): error is TeamChangedError {
  return error instanceof TeamChangedError;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const code = data?.error ?? record.error ?? record.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function isInvalidCursor(error: unknown): boolean {
  return errorCode(error) === "invalid_cursor";
}

function parseRunError(raw: string | null): RunError {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as RunError) : {};
  } catch {
    return {};
  }
}

function serializeRunError(value: RunError): string | null {
  return Object.keys(value).length > 0 ? JSON.stringify(value) : null;
}

function profileFromUser(user: SlackIndexingUser, teamId: string, fetchedAt: string): SlackUserProfile | null {
  if (!user.slackUserId) return null;
  return {
    teamId,
    slackUserId: user.slackUserId,
    name: user.name,
    realName: user.realName,
    displayName: user.displayName ?? null,
    email: user.email,
    profileTeamId: user.profileTeamId ?? null,
    isBot: user.isBot,
    isGuest: user.isGuest ?? false,
    isStranger: user.isStranger ?? false,
    isRestricted: user.isRestricted ?? false,
    isUltraRestricted: user.isUltraRestricted ?? false,
    deleted: user.deleted ?? false,
    providerUpdatedAt: user.providerUpdatedAt ?? null,
    fetchedAt,
  };
}

function isPendingState(state: PendingState): boolean {
  if (!state.profile_json) return false;
  try {
    const value = JSON.parse(state.profile_json) as unknown;
    return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).status === "pending");
  } catch {
    return false;
  }
}

async function writePendingState(
  trx: Kysely<DB>,
  teamId: string,
  slackUserId: string,
  reason: string,
  now: string,
): Promise<void> {
  await trx
    .insertInto("slack_user_sync_state")
    .values({
      team_id: teamId,
      slack_user_id: slackUserId,
      name: null,
      real_name: null,
      display_name: null,
      email: null,
      profile_team_id: null,
      profile_json: JSON.stringify({ status: "pending", reason }),
      is_bot: 0,
      is_guest: 0,
      is_stranger: 0,
      is_restricted: 0,
      is_ultra_restricted: 0,
      deleted: 0,
      classification: null,
      classification_source: null,
      provider_updated_at: null,
      fetched_at: now,
      entity_id: null,
      inactive_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(["team_id", "slack_user_id"]).doNothing())
    .execute();
}

export function createSlackEntitySync(deps: SlackEntitySyncDeps): SlackEntitySyncService {
  const now = deps.now ?? (() => new Date().toISOString());
  const staleRunMs = deps.staleRunMs ?? DEFAULT_STALE_RUN_MS;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const userInfoCap = deps.userInfoCap ?? DEFAULT_USER_INFO_CAP;
  const inflightByTeam = new Map<string, Promise<void>>();
  let stopped = false;

  async function reclaimStaleRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - staleRunMs).toISOString();
    await deps.db
      .updateTable("slack_sync_runs")
      .set({
        status: RUN_STATUS_QUEUED,
        heartbeat_at: null,
        error: JSON.stringify({ kind: "stale_run_reclaimed" }),
        updated_at: now(),
      })
      .where("status", "=", RUN_STATUS_RUNNING)
      .where("heartbeat_at", "is not", null)
      .where("heartbeat_at", "<", cutoff)
      .execute();
  }

  async function ensureRun(connection: SlackEntitySyncConnection): Promise<SyncRun> {
    const timestamp = now();
    await deps.db
      .insertInto("slack_sync_runs")
      .values({
        id: randomUUID(),
        team_id: connection.teamId,
        run_type: "backfill",
        trigger_key: BACKFILL_TRIGGER_KEY,
        pinned_team_id: connection.teamId,
        status: RUN_STATUS_QUEUED,
        stage: INITIAL_STAGE,
        heartbeat_at: null,
        users_cursor: null,
        conversations_cursor: null,
        members_cursor: null,
        current_channel_id: null,
        started_at: timestamp,
        completed_at: null,
        error: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .onConflict((oc) => oc.columns(["team_id", "trigger_key"]).doNothing())
      .execute();

    const run = await deps.db
      .selectFrom("slack_sync_runs")
      .selectAll()
      .where("team_id", "=", connection.teamId)
      .where("trigger_key", "=", BACKFILL_TRIGGER_KEY)
      .executeTakeFirstOrThrow();

    if (run.status === RUN_STATUS_FAILED || run.status === RUN_STATUS_ABORTED) {
      await deps.db
        .updateTable("slack_sync_runs")
        .set({ status: RUN_STATUS_QUEUED, heartbeat_at: null, error: null, updated_at: timestamp })
        .where("id", "=", run.id)
        .execute();
      return { ...run, status: RUN_STATUS_QUEUED, heartbeat_at: null, error: null, updated_at: timestamp };
    }
    return run;
  }

  async function claimRun(run: SyncRun): Promise<SyncRun | null> {
    const timestamp = now();
    const staleCutoff = new Date(Date.now() - staleRunMs).toISOString();
    const result = await deps.db
      .updateTable("slack_sync_runs")
      .set({ status: RUN_STATUS_RUNNING, heartbeat_at: timestamp, updated_at: timestamp })
      .where("id", "=", run.id)
      .where((eb) =>
        eb.or([
          eb("status", "=", RUN_STATUS_QUEUED),
          eb("status", "=", RUN_STATUS_FAILED),
          eb("status", "=", RUN_STATUS_ABORTED),
          eb.and([
            eb("status", "=", RUN_STATUS_RUNNING),
            eb("heartbeat_at", "is not", null),
            eb("heartbeat_at", "<", staleCutoff),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return null;
    return { ...run, status: RUN_STATUS_RUNNING, heartbeat_at: timestamp, updated_at: timestamp };
  }

  async function updateRun(run: SyncRun, patch: RunPatch): Promise<void> {
    const timestamp = patch.updated_at ?? now();
    const next = { ...patch, updated_at: timestamp };
    await deps.db.updateTable("slack_sync_runs").set(next).where("id", "=", run.id).execute();
    Object.assign(run, next);
  }

  async function updateRunInTransaction(trx: Kysely<DB>, run: SyncRun, patch: RunPatch): Promise<RunPatch> {
    const timestamp = patch.updated_at ?? now();
    const next = { ...patch, updated_at: timestamp };
    await trx.updateTable("slack_sync_runs").set(next).where("id", "=", run.id).execute();
    return next;
  }

  async function assertActiveTeam(run: SyncRun): Promise<void> {
    const active = await deps.getActiveConnection();
    if (!active || active.teamId !== run.pinned_team_id) throw new TeamChangedError();
  }

  async function recordSkipReason(run: SyncRun, channelId: string, reason: string): Promise<void> {
    const details = parseRunError(run.error);
    const reasons = details.skipReasons ?? [];
    if (!reasons.some((entry) => entry.channelId === channelId && entry.reason === reason)) {
      reasons.push({ channelId, reason });
    }
    await updateRun(run, {
      error: serializeRunError({ ...details, skipReasons: reasons }),
      current_channel_id: null,
      members_cursor: null,
      heartbeat_at: now(),
    });
  }

  async function recordSkipReasonInTransaction(
    trx: Kysely<DB>,
    run: SyncRun,
    channelId: string,
    reason: string,
  ): Promise<RunPatch> {
    const details = parseRunError(run.error);
    const reasons = details.skipReasons ?? [];
    if (!reasons.some((entry) => entry.channelId === channelId && entry.reason === reason)) {
      reasons.push({ channelId, reason });
    }
    return updateRunInTransaction(trx, run, {
      error: serializeRunError({ ...details, skipReasons: reasons }),
      current_channel_id: null,
      members_cursor: null,
      heartbeat_at: now(),
    });
  }

  async function resolveRosterProfiles(
    teamId: string,
    memberIds: string[],
    facade: SlackEntitySyncFacade,
    fetchedAt: string,
    infoFetchedIds: Set<string>,
    infoLookups: { count: number },
  ): Promise<{ profiles: SlackUserProfile[]; pending: Array<{ id: string; reason: string }> }> {
    const profiles: SlackUserProfile[] = [];
    const pending: Array<{ id: string; reason: string }> = [];
    for (const slackUserId of new Set(memberIds)) {
      const state = await deps.db
        .selectFrom("slack_user_sync_state")
        .selectAll()
        .where("team_id", "=", teamId)
        .where("slack_user_id", "=", slackUserId)
        .executeTakeFirst();
      if (state && !isPendingState(state)) continue;
      if (infoFetchedIds.has(slackUserId)) continue;
      infoFetchedIds.add(slackUserId);
      if (infoLookups.count >= userInfoCap) {
        pending.push({ id: slackUserId, reason: "users.info_cap" });
        continue;
      }
      infoLookups.count += 1;
      try {
        const user = await facade.getUserInfo(slackUserId);
        const profile = profileFromUser(user, teamId, fetchedAt);
        if (profile) profiles.push(profile);
        else pending.push({ id: slackUserId, reason: "users.info_unreadable" });
      } catch (error) {
        pending.push({ id: slackUserId, reason: errorCode(error) ?? "users.info_unreadable" });
      }
    }
    return { profiles, pending };
  }

  async function runUsersStage(run: SyncRun, connection: SlackEntitySyncConnection, facade: SlackEntitySyncFacade) {
    let cursor = run.users_cursor ?? undefined;
    let restarted = false;
    const seenCursors = new Set<string>();
    while (true) {
      await assertActiveTeam(run);
      if (cursor && seenCursors.has(cursor)) throw new Error("Slack users.list returned a repeated cursor");
      if (cursor) seenCursors.add(cursor);
      let page: SlackIndexingPage<SlackIndexingUser>;
      try {
        page = await facade.listUsersPage(cursor);
      } catch (error) {
        if (cursor && isInvalidCursor(error) && !restarted) {
          restarted = true;
          cursor = undefined;
          await updateRun(run, { users_cursor: null, heartbeat_at: now() });
          continue;
        }
        throw error;
      }
      await assertActiveTeam(run);
      const fetchedAt = now();
      const nextCursor = page.nextCursor;
      const patch: RunPatch = nextCursor
        ? { users_cursor: nextCursor, heartbeat_at: fetchedAt }
        : {
            stage: CONVERSATIONS_STAGE,
            users_cursor: null,
            conversations_cursor: run.conversations_cursor,
            heartbeat_at: fetchedAt,
          };
      const committedPatch = await deps.db.transaction().execute(async (trx) => {
        for (const user of page.items) {
          if (user.isBot) continue;
          const profile = profileFromUser(user, connection.teamId, fetchedAt);
          if (!profile) continue;
          await upsertSlackPersonEntityInTransaction(trx, profile);
        }
        return updateRunInTransaction(trx, run, patch);
      });
      Object.assign(run, committedPatch);
      cursor = nextCursor ?? undefined;
      if (!cursor) return;
    }
  }

  async function syncChannel(
    run: SyncRun,
    connection: SlackEntitySyncConnection,
    facade: SlackEntitySyncFacade,
    channel: SlackIndexingChannel,
    infoFetchedIds: Set<string>,
    infoLookups: { count: number },
  ): Promise<void> {
    if (run.current_channel_id !== channel.id) {
      await updateRun(run, { current_channel_id: channel.id, members_cursor: null, heartbeat_at: now() });
    }
    let cursor = run.members_cursor ?? undefined;
    let restarted = false;
    const seenCursors = new Set<string>();
    while (true) {
      await assertActiveTeam(run);
      if (cursor && seenCursors.has(cursor)) throw new Error("Slack conversations.members returned a repeated cursor");
      if (cursor) seenCursors.add(cursor);
      let page: SlackIndexingPage<string>;
      try {
        page = await facade.listChannelMembersPage(channel.id, cursor);
      } catch (error) {
        if (cursor && isInvalidCursor(error) && !restarted) {
          restarted = true;
          cursor = undefined;
          await updateRun(run, { members_cursor: null, heartbeat_at: now() });
          continue;
        }
        await recordSkipReason(run, channel.id, errorCode(error) ?? "members_read_failed");
        return;
      }
      await assertActiveTeam(run);
      const fetchedAt = now();
      const resolved = await resolveRosterProfiles(
        connection.teamId,
        page.items,
        facade,
        fetchedAt,
        infoFetchedIds,
        infoLookups,
      );
      await assertActiveTeam(run);
      const nextCursor = page.nextCursor;
      const patch = await deps.db.transaction().execute(async (trx) => {
        for (const profile of resolved.profiles) {
          await upsertSlackPersonEntityInTransaction(trx, profile);
        }
        for (const pending of resolved.pending) {
          await writePendingState(trx, connection.teamId, pending.id, pending.reason, fetchedAt);
        }
        return updateRunInTransaction(trx, run, {
          current_channel_id: nextCursor ? channel.id : null,
          members_cursor: nextCursor,
          heartbeat_at: fetchedAt,
        });
      });
      Object.assign(run, patch);
      cursor = nextCursor ?? undefined;
      if (!cursor) return;
    }
  }

  async function runConversationsStage(
    run: SyncRun,
    connection: SlackEntitySyncConnection,
    facade: SlackEntitySyncFacade,
  ): Promise<void> {
    let cursor = run.conversations_cursor ?? undefined;
    let restarted = false;
    const seenCursors = new Set<string>();
    const infoFetchedIds = new Set<string>();
    const infoLookups = { count: 0 };
    while (true) {
      await assertActiveTeam(run);
      if (cursor && seenCursors.has(cursor)) throw new Error("Slack conversations.list returned a repeated cursor");
      if (cursor) seenCursors.add(cursor);
      let page: SlackIndexingPage<SlackIndexingChannel>;
      try {
        page = await facade.listChannelsPage(cursor);
      } catch (error) {
        if (cursor && isInvalidCursor(error) && !restarted) {
          restarted = true;
          cursor = undefined;
          await updateRun(run, {
            conversations_cursor: null,
            current_channel_id: null,
            members_cursor: null,
            heartbeat_at: now(),
          });
          continue;
        }
        throw error;
      }
      await assertActiveTeam(run);
      let resumeChannel = run.current_channel_id;
      let resumeFound = resumeChannel === null;
      for (const channel of page.items) {
        if (resumeChannel && !resumeFound) {
          if (channel.id === resumeChannel) resumeFound = true;
          else continue;
        }
        const isPublic = channel.isPrivate !== true;
        const shouldSync = isPublic ? deps.publicChannelsEnabled : channel.isMember === true;
        if (!shouldSync) {
          const patch = await deps.db.transaction().execute(async (trx) => {
            return recordSkipReasonInTransaction(
              trx,
              run,
              channel.id,
              isPublic ? "public_channels_disabled" : "private_channel_not_member",
            );
          });
          Object.assign(run, patch);
          resumeChannel = null;
          continue;
        }
        await syncChannel(run, connection, facade, channel, infoFetchedIds, infoLookups);
        resumeChannel = null;
      }
      if (resumeChannel && !resumeFound) {
        await updateRun(run, { current_channel_id: null, members_cursor: null, heartbeat_at: now() });
      }
      const nextCursor = page.nextCursor;
      const patch = await deps.db.transaction().execute(async (trx) => {
        return updateRunInTransaction(trx, run, {
          conversations_cursor: nextCursor,
          current_channel_id: null,
          members_cursor: null,
          heartbeat_at: now(),
        });
      });
      Object.assign(run, patch);
      cursor = nextCursor ?? undefined;
      if (!cursor) return;
    }
  }

  async function touchHeartbeat(run: SyncRun): Promise<void> {
    try {
      await deps.db
        .updateTable("slack_sync_runs")
        .set({ heartbeat_at: now(), updated_at: now() })
        .where("id", "=", run.id)
        .where("status", "=", RUN_STATUS_RUNNING)
        .execute();
    } catch (error) {
      deps.logger.warn({ error, runId: run.id }, "Slack entity sync heartbeat failed");
    }
  }

  async function executeRun(run: SyncRun, connection: SlackEntitySyncConnection): Promise<void> {
    const facade = deps.createFacade(connection.botToken);
    const heartbeat = setInterval(() => void touchHeartbeat(run), heartbeatMs);
    heartbeat.unref?.();
    try {
      if (run.stage === INITIAL_STAGE) await runUsersStage(run, connection, facade);
      if (run.stage === CONVERSATIONS_STAGE) await runConversationsStage(run, connection, facade);
      await updateRun(run, {
        status: RUN_STATUS_COMPLETED,
        stage: COMPLETED_STAGE,
        heartbeat_at: now(),
        completed_at: now(),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function markRunFailed(run: SyncRun, error: unknown): Promise<void> {
    const details = parseRunError(run.error);
    await updateRun(run, {
      status: RUN_STATUS_FAILED,
      heartbeat_at: null,
      error: serializeRunError({
        ...details,
        kind: "run_failed",
        ...(errorCode(error) ? { code: errorCode(error) ?? undefined } : {}),
      }),
    });
  }

  async function markRunAborted(run: SyncRun): Promise<void> {
    const details = parseRunError(run.error);
    await updateRun(run, {
      status: RUN_STATUS_ABORTED,
      heartbeat_at: null,
      error: serializeRunError({ ...details, kind: "team_changed" }),
    });
  }

  async function runTeam(connection: SlackEntitySyncConnection): Promise<void> {
    if (stopped) return;
    const run = await ensureRun(connection);
    if (run.status === RUN_STATUS_COMPLETED) return;
    const claimed = await claimRun(run);
    if (!claimed) return;
    try {
      await executeRun(claimed, connection);
    } catch (error) {
      if (isTeamChangedError(error)) {
        await markRunAborted(claimed);
        deps.logger.warn(
          { runId: claimed.id, teamId: connection.teamId },
          "Slack entity sync aborted after team change",
        );
        return;
      }
      await markRunFailed(claimed, error);
      deps.logger.warn({ error, runId: claimed.id, teamId: connection.teamId }, "Slack entity sync failed");
    }
  }

  function enqueueBackfill(connection: SlackEntitySyncConnection): Promise<void> {
    if (!deps.enabled || stopped) return Promise.resolve();
    const existing = inflightByTeam.get(connection.teamId);
    if (existing) return existing;
    const pending = runTeam(connection);
    inflightByTeam.set(connection.teamId, pending);
    return pending.finally(() => {
      if (inflightByTeam.get(connection.teamId) === pending) inflightByTeam.delete(connection.teamId);
    });
  }

  function start(): void {
    if (!deps.enabled || stopped) return;
    void (async () => {
      await reclaimStaleRuns();
      const connection = await deps.getActiveConnection();
      if (connection) await enqueueBackfill(connection);
    })().catch((error) => deps.logger.warn({ error }, "Slack entity sync startup recovery failed"));
  }

  async function stop(): Promise<void> {
    stopped = true;
    await Promise.allSettled(inflightByTeam.values());
  }

  function onConnectionActivated(connection: SlackEntitySyncConnection): void {
    void enqueueBackfill(connection).catch((error) => {
      deps.logger.warn({ error, teamId: connection.teamId }, "Slack entity sync could not be enqueued");
    });
  }

  return { start, stop, onConnectionActivated, enqueueBackfill };
}
