import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { type SlackUserProfile, upsertSlackPersonEntityInTransaction } from "../db/repositories/slack-entity-sync";
import type { DB, SlackSyncRunsTable, SlackUserSyncStateTable } from "../db/schema";
import type { Logger } from "../logger";
import type { SlackIndexingChannel, SlackIndexingPage, SlackIndexingUser } from "./indexing-facade";

const BACKFILL_RUN_TYPE = "backfill";
const BACKFILL_TRIGGER_KEY = "backfill";
const SWEEP_RUN_TYPE = "sweep";
const SWEEP_TRIGGER_KEY = "sweep";
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
const DEFAULT_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_TIMER_INTERVAL_MS = 60 * 1000;

export interface SlackEntitySyncConnection {
  botToken: string;
  teamId: string;
}

export type SlackEntityUserEvent = {
  eventType: "team_join" | "user_change";
  teamId?: string;
  slackUserId: string;
};

export type SlackEntityChannelJoinEvent = {
  teamId?: string;
  channelId: string;
};

export type SlackEntityMessageObservation = {
  teamId?: string;
  slackUserId: string;
};

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
  sweepIntervalMs?: number;
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
  enqueueSweep: (connection: SlackEntitySyncConnection) => Promise<void>;
  handleUserEvent: (event: SlackEntityUserEvent) => Promise<void>;
  handleBotJoinedChannel: (event: SlackEntityChannelJoinEvent) => Promise<void>;
  observeMessage: (event: SlackEntityMessageObservation) => Promise<void>;
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

type SyncCounters = {
  scanned: number;
  created: number;
  linked: number;
  reclassified: number;
  deactivated: number;
  skipped: number;
  retries: number;
  userInfoSpillover: number;
};

function emptySyncCounters(): SyncCounters {
  return {
    scanned: 0,
    created: 0,
    linked: 0,
    reclassified: 0,
    deactivated: 0,
    skipped: 0,
    retries: 0,
    userInfoSpillover: 0,
  };
}

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
  const sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const inflightByTeam = new Map<string, Promise<void>>();
  let stopped = false;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

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

  async function ensureRun(
    connection: SlackEntitySyncConnection,
    runType: string,
    triggerKey: string,
  ): Promise<SyncRun> {
    const timestamp = now();
    await deps.db
      .insertInto("slack_sync_runs")
      .values({
        id: randomUUID(),
        team_id: connection.teamId,
        run_type: runType,
        trigger_key: triggerKey,
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
      .where("trigger_key", "=", triggerKey)
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

  async function queueCompletedRun(run: SyncRun): Promise<SyncRun> {
    const timestamp = now();
    await deps.db
      .updateTable("slack_sync_runs")
      .set({
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
        updated_at: timestamp,
      })
      .where("id", "=", run.id)
      .execute();
    return {
      ...run,
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
      updated_at: timestamp,
    };
  }

  async function claimRun(run: SyncRun): Promise<SyncRun | null> {
    const activeRun = await deps.db
      .selectFrom("slack_sync_runs")
      .select("id")
      .where("team_id", "=", run.team_id)
      .where("id", "!=", run.id)
      .where("status", "in", [RUN_STATUS_QUEUED, RUN_STATUS_RUNNING])
      .executeTakeFirst();
    if (activeRun) return null;
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
    refreshExisting: boolean,
    counters?: SyncCounters,
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
      if (state && !isPendingState(state) && !refreshExisting) continue;
      if (infoFetchedIds.has(slackUserId)) continue;
      infoFetchedIds.add(slackUserId);
      if (infoLookups.count >= userInfoCap) {
        if (counters) counters.userInfoSpillover += 1;
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

  async function resolveEventConnection(teamId: string | undefined): Promise<SlackEntitySyncConnection | null> {
    const connection = await deps.getActiveConnection();
    if (!connection) return null;
    if (teamId && connection.teamId !== teamId) {
      deps.logger.warn(
        { eventTeamId: teamId, activeTeamId: connection.teamId },
        "Dropped Slack entity event from another team",
      );
      return null;
    }
    return connection;
  }

  async function upsertFetchedUser(
    connection: SlackEntitySyncConnection,
    slackUserId: string,
    facade: SlackEntitySyncFacade,
  ): Promise<void> {
    const fetchedAt = now();
    const user = await facade.getUserInfo(slackUserId);
    await assertActiveConnection(connection);
    const profile = profileFromUser(user, connection.teamId, fetchedAt);
    if (!profile || profile.isBot) return;
    await deps.db.transaction().execute(async (trx) => {
      await upsertSlackPersonEntityInTransaction(trx, profile);
    });
  }

  async function assertActiveConnection(connection: SlackEntitySyncConnection): Promise<void> {
    const active = await deps.getActiveConnection();
    if (!active || active.teamId !== connection.teamId) throw new TeamChangedError();
  }

  async function syncImmediateChannelRoster(
    connection: SlackEntitySyncConnection,
    channelId: string,
    facade: SlackEntitySyncFacade,
  ): Promise<void> {
    let cursor: string | undefined;
    let restarted = false;
    const infoFetchedIds = new Set<string>();
    const infoLookups = { count: 0 };
    const seenCursors = new Set<string>();
    while (true) {
      await assertActiveConnection(connection);
      if (cursor && seenCursors.has(cursor)) throw new Error("Slack conversations.members returned a repeated cursor");
      if (cursor) seenCursors.add(cursor);
      let page: SlackIndexingPage<string>;
      try {
        page = await facade.listChannelMembersPage(channelId, cursor);
      } catch (error) {
        if (cursor && isInvalidCursor(error) && !restarted) {
          restarted = true;
          cursor = undefined;
          continue;
        }
        throw error;
      }
      const fetchedAt = now();
      const resolved = await resolveRosterProfiles(
        connection.teamId,
        page.items,
        facade,
        fetchedAt,
        infoFetchedIds,
        infoLookups,
        false,
      );
      await assertActiveConnection(connection);
      await deps.db.transaction().execute(async (trx) => {
        for (const profile of resolved.profiles) {
          await upsertSlackPersonEntityInTransaction(trx, profile);
        }
        for (const pending of resolved.pending) {
          await writePendingState(trx, connection.teamId, pending.id, pending.reason, fetchedAt);
        }
      });
      cursor = page.nextCursor ?? undefined;
      if (!cursor) return;
    }
  }

  async function handleUserEvent(event: SlackEntityUserEvent): Promise<void> {
    if (!deps.enabled) return;
    const connection = await resolveEventConnection(event.teamId);
    if (!connection) return;
    const facade = deps.createFacade(connection.botToken);
    try {
      await upsertFetchedUser(connection, event.slackUserId, facade);
      deps.logger.info(
        { eventType: event.eventType, teamId: connection.teamId, slackUserId: event.slackUserId },
        "Applied Slack lifecycle user event",
      );
    } catch (error) {
      if (isTeamChangedError(error)) throw error;
      deps.logger.warn(
        { error, eventType: event.eventType, teamId: connection.teamId, slackUserId: event.slackUserId },
        "Slack lifecycle user event profile refresh failed",
      );
    }
  }

  async function handleBotJoinedChannel(event: SlackEntityChannelJoinEvent): Promise<void> {
    if (!deps.enabled) return;
    const connection = await resolveEventConnection(event.teamId);
    if (!connection) return;
    const key = `${connection.teamId}:${event.channelId}`;
    const existing = inflightByTeam.get(key);
    if (existing) return existing;
    const pending = (async () => {
      try {
        await syncImmediateChannelRoster(connection, event.channelId, deps.createFacade(connection.botToken));
        deps.logger.info(
          { teamId: connection.teamId, channelId: event.channelId },
          "Completed Slack channel roster refresh after bot join",
        );
      } catch (error) {
        deps.logger.warn(
          { error, teamId: connection.teamId, channelId: event.channelId },
          "Slack channel roster refresh after bot join failed",
        );
      }
    })();
    inflightByTeam.set(key, pending);
    await pending.finally(() => {
      if (inflightByTeam.get(key) === pending) inflightByTeam.delete(key);
    });
  }

  async function observeMessage(event: SlackEntityMessageObservation): Promise<void> {
    if (!deps.enabled) return;
    const connection = await resolveEventConnection(event.teamId);
    if (!connection) return;
    const existing = await deps.db
      .selectFrom("slack_user_sync_state")
      .select("slack_user_id")
      .where("team_id", "=", connection.teamId)
      .where("slack_user_id", "=", event.slackUserId)
      .executeTakeFirst();
    if (existing) return;
    try {
      await upsertFetchedUser(connection, event.slackUserId, deps.createFacade(connection.botToken));
      deps.logger.info(
        { teamId: connection.teamId, slackUserId: event.slackUserId },
        "Observed Slack message sender in entity sync",
      );
    } catch (error) {
      if (isTeamChangedError(error)) throw error;
      deps.logger.warn(
        { error, teamId: connection.teamId, slackUserId: event.slackUserId },
        "Observe-on-message Slack profile refresh failed",
      );
    }
  }

  async function upsertProfileWithCounters(
    trx: Kysely<DB>,
    profile: SlackUserProfile,
    counters?: SyncCounters,
  ): Promise<void> {
    const before = counters
      ? await trx
          .selectFrom("slack_user_sync_state")
          .select(["entity_id", "classification", "inactive_at"])
          .where("team_id", "=", profile.teamId)
          .where("slack_user_id", "=", profile.slackUserId)
          .executeTakeFirst()
      : undefined;
    const result = await upsertSlackPersonEntityInTransaction(trx, profile);
    if (!counters) return;
    counters.scanned += 1;
    if (!result.applied) {
      counters.skipped += 1;
      return;
    }
    if (!before?.entity_id && result.state.entity_id) {
      counters[before ? "linked" : "created"] += 1;
    }
    if (before?.classification !== result.state.classification) counters.reclassified += 1;
    if (!before?.inactive_at && result.state.inactive_at) counters.deactivated += 1;
  }

  async function runUsersStage(
    run: SyncRun,
    connection: SlackEntitySyncConnection,
    facade: SlackEntitySyncFacade,
    counters: SyncCounters,
  ) {
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
          counters.retries += 1;
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
          await upsertProfileWithCounters(trx, profile, counters);
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
    refreshExisting: boolean,
    rosterUserIds: Set<string> | undefined,
    counters: SyncCounters,
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
          counters.retries += 1;
          cursor = undefined;
          await updateRun(run, { members_cursor: null, heartbeat_at: now() });
          continue;
        }
        counters.skipped += 1;
        await recordSkipReason(run, channel.id, errorCode(error) ?? "members_read_failed");
        return;
      }
      await assertActiveTeam(run);
      for (const memberId of page.items) rosterUserIds?.add(memberId);
      const fetchedAt = now();
      const resolved = await resolveRosterProfiles(
        connection.teamId,
        page.items,
        facade,
        fetchedAt,
        infoFetchedIds,
        infoLookups,
        refreshExisting,
        counters,
      );
      await assertActiveTeam(run);
      const nextCursor = page.nextCursor;
      const patch = await deps.db.transaction().execute(async (trx) => {
        for (const profile of resolved.profiles) {
          await upsertProfileWithCounters(trx, profile, counters);
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
    counters: SyncCounters,
  ): Promise<{ rosterUserIds: Set<string>; complete: boolean }> {
    let cursor = run.conversations_cursor ?? undefined;
    let restarted = false;
    const seenCursors = new Set<string>();
    const infoFetchedIds = new Set<string>();
    const infoLookups = { count: 0 };
    const rosterUserIds = new Set<string>();
    let complete = true;
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
          counters.retries += 1;
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
        await syncChannel(
          run,
          connection,
          facade,
          channel,
          infoFetchedIds,
          infoLookups,
          run.run_type === SWEEP_RUN_TYPE,
          rosterUserIds,
          counters,
        );
        const details = parseRunError(run.error);
        if (details.skipReasons?.some((reason) => reason.channelId === channel.id)) complete = false;
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
      if (!cursor) return { rosterUserIds, complete };
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

  async function tombstoneAbsentExternals(
    connection: SlackEntitySyncConnection,
    crawlStartedAt: string,
    rosterUserIds: Set<string>,
    counters: SyncCounters,
  ): Promise<void> {
    const candidates = await deps.db
      .selectFrom("slack_user_sync_state")
      .select(["slack_user_id", "updated_at"])
      .where("team_id", "=", connection.teamId)
      .where("classification", "=", "external")
      .where("inactive_at", "is", null)
      .where("updated_at", "<=", crawlStartedAt)
      .execute();
    for (const candidate of candidates) {
      if (rosterUserIds.has(candidate.slack_user_id)) continue;
      const result = await deps.db
        .updateTable("slack_user_sync_state")
        .set({ inactive_at: now(), updated_at: now() })
        .where("team_id", "=", connection.teamId)
        .where("slack_user_id", "=", candidate.slack_user_id)
        .where("classification", "=", "external")
        .where("inactive_at", "is", null)
        .where("updated_at", "<=", crawlStartedAt)
        .executeTakeFirst();
      if (result.numUpdatedRows > 0n) counters.deactivated += 1;
    }
  }

  async function executeRun(run: SyncRun, connection: SlackEntitySyncConnection): Promise<void> {
    const facade = deps.createFacade(connection.botToken);
    const heartbeat = setInterval(() => void touchHeartbeat(run), heartbeatMs);
    heartbeat.unref?.();
    const counters = emptySyncCounters();
    const startedStage = run.stage;
    let rosterUserIds = new Set<string>();
    let channelCrawlComplete = false;
    try {
      if (run.stage === INITIAL_STAGE) await runUsersStage(run, connection, facade, counters);
      if (run.stage === CONVERSATIONS_STAGE) {
        const result = await runConversationsStage(run, connection, facade, counters);
        rosterUserIds = result.rosterUserIds;
        channelCrawlComplete = result.complete;
      }
      if (run.run_type === SWEEP_RUN_TYPE && startedStage === INITIAL_STAGE && channelCrawlComplete) {
        await tombstoneAbsentExternals(connection, run.started_at, rosterUserIds, counters);
      }
      await updateRun(run, {
        status: RUN_STATUS_COMPLETED,
        stage: COMPLETED_STAGE,
        heartbeat_at: now(),
        completed_at: now(),
      });
      deps.logger.info(
        {
          runId: run.id,
          runType: run.run_type,
          teamId: connection.teamId,
          ...counters,
        },
        "Completed Slack entity sync run",
      );
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

  async function runTeam(connection: SlackEntitySyncConnection, runType: string, triggerKey: string): Promise<void> {
    if (stopped) return;
    const run = await ensureRun(connection, runType, triggerKey);
    if (run.status === RUN_STATUS_COMPLETED) return;
    const claimed = await claimRun(run);
    if (!claimed) return;
    try {
      await executeRun(claimed, connection);
      if (claimed.run_type === BACKFILL_RUN_TYPE) {
        await runTeam(connection, SWEEP_RUN_TYPE, `repair-after-backfill:${claimed.id}`);
      }
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
    const pending = runTeam(connection, BACKFILL_RUN_TYPE, BACKFILL_TRIGGER_KEY);
    inflightByTeam.set(connection.teamId, pending);
    return pending.finally(() => {
      if (inflightByTeam.get(connection.teamId) === pending) inflightByTeam.delete(connection.teamId);
    });
  }

  async function enqueueSweep(connection: SlackEntitySyncConnection): Promise<void> {
    if (!deps.enabled || stopped) return;
    const existing = inflightByTeam.get(connection.teamId);
    if (existing) return existing;
    const pending = runTeam(connection, SWEEP_RUN_TYPE, `${SWEEP_TRIGGER_KEY}:${randomUUID()}`);
    inflightByTeam.set(connection.teamId, pending);
    await pending.finally(() => {
      if (inflightByTeam.get(connection.teamId) === pending) inflightByTeam.delete(connection.teamId);
    });
  }

  async function enqueueScheduledSweep(connection: SlackEntitySyncConnection): Promise<void> {
    if (!deps.enabled || stopped) return;
    const active = await deps.db
      .selectFrom("slack_sync_runs")
      .select("id")
      .where("team_id", "=", connection.teamId)
      .where("status", "in", [RUN_STATUS_QUEUED, RUN_STATUS_RUNNING])
      .executeTakeFirst();
    if (active) return;

    const latest = await deps.db
      .selectFrom("slack_sync_runs")
      .select("completed_at")
      .where("team_id", "=", connection.teamId)
      .where("run_type", "=", SWEEP_RUN_TYPE)
      .where("status", "=", RUN_STATUS_COMPLETED)
      .where("completed_at", "is not", null)
      .orderBy("completed_at", "desc")
      .executeTakeFirst();
    if (latest?.completed_at && Date.now() - Date.parse(latest.completed_at) < sweepIntervalMs) return;

    let run = await ensureRun(connection, SWEEP_RUN_TYPE, SWEEP_TRIGGER_KEY);
    if (run.status === RUN_STATUS_COMPLETED) run = await queueCompletedRun(run);
    await runTeam(connection, run.run_type, run.trigger_key);
  }

  function start(): void {
    if (!deps.enabled || stopped) return;
    if (!sweepTimer) {
      sweepTimer = setInterval(
        () => {
          void deps
            .getActiveConnection()
            .then((connection) => (connection ? enqueueScheduledSweep(connection) : undefined))
            .catch((error) => deps.logger.warn({ error }, "Slack entity sweep scheduler failed"));
        },
        Math.min(sweepIntervalMs, SWEEP_TIMER_INTERVAL_MS),
      );
      sweepTimer.unref?.();
    }
    void (async () => {
      await reclaimStaleRuns();
      const connection = await deps.getActiveConnection();
      if (connection) {
        await enqueueBackfill(connection);
        await enqueueScheduledSweep(connection);
      }
    })().catch((error) => deps.logger.warn({ error }, "Slack entity sync startup recovery failed"));
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    await Promise.allSettled(inflightByTeam.values());
  }

  function onConnectionActivated(connection: SlackEntitySyncConnection): void {
    void enqueueBackfill(connection).catch((error) => {
      deps.logger.warn({ error, teamId: connection.teamId }, "Slack entity sync could not be enqueued");
    });
  }

  return {
    start,
    stop,
    onConnectionActivated,
    enqueueBackfill,
    enqueueSweep,
    handleUserEvent,
    handleBotJoinedChannel,
    observeMessage,
  };
}
