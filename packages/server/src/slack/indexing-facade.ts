import { WebClient } from "@slack/web-api";
import type { Kysely } from "kysely";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import type { CachedUser, UserCache } from "./user-cache";
import { UserCache as SlackUserCache } from "./user-cache";

const SLACK_PAGE_LIMIT = 200;

export interface SlackIndexingChannel {
  id: string;
  name: string;
  isMember?: boolean;
  isPrivate?: boolean;
  isArchived?: boolean;
}

export interface SlackIndexingUser {
  slackUserId?: string;
  name: string;
  realName: string;
  displayName?: string;
  email: string | null;
  phone: string | null;
  profileTeamId?: string | null;
  isBot: boolean;
  isGuest?: boolean;
  isStranger?: boolean;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
  deleted?: boolean;
  providerUpdatedAt?: string | null;
}

export interface SlackIndexingPage<T> {
  items: T[];
  nextCursor: string | null;
}

type SlackIndexingClient = Pick<WebClient, "users" | "conversations">;

interface SlackApiLimiter {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

class SerializedSlackApiLimiter implements SlackApiLimiter {
  private tail = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(private readonly minimumIntervalMs = 50) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const delayMs = Math.max(0, this.nextAllowedAt - Date.now());
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const value = await operation();
        this.nextAllowedAt = Date.now() + this.minimumIntervalMs;
        return value;
      } catch (error) {
        const retryAfterMs = readRetryAfterMs(error);
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + retryAfterMs);
        throw error;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

type SharedSlackConnection = {
  client: SlackIndexingClient;
  limiter: SlackApiLimiter;
  clientFactory: (token: string) => SlackIndexingClient;
  owners: Set<object>;
  oauthScopeCapture: { scopes: string[] | null; observed: boolean };
};

const sharedConnectionsByToken = new Map<string, SharedSlackConnection>();

function defaultClientFactory(token: string): SlackIndexingClient {
  return new WebClient(token);
}

export function normalizeSlackProviderUpdatedAt(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw.padStart(20, "0");
  const numeric = Number(raw);
  const epochSeconds = Number.isFinite(numeric) ? Math.trunc(numeric) : Math.trunc(Date.parse(raw) / 1000);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) return null;
  return String(epochSeconds).padStart(20, "0");
}

function readRetryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const retryAfter = data?.retryAfter ?? data?.retry_after ?? record.retryAfter ?? record.retry_after;
  const seconds = typeof retryAfter === "number" ? retryAfter : Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

function readOAuthScopes(value: unknown): string[] | null {
  const scopes = readRecord(value).scopes;
  if (!Array.isArray(scopes)) return null;
  const normalized = scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
  return normalized.length > 0 ? normalized : [];
}

function mapUser(user: unknown, fallbackId?: string): SlackIndexingUser {
  const raw = readRecord(user);
  const profile = readRecord(raw.profile);
  const id = readString(raw, "id") ?? fallbackId;
  const name = readString(raw, "name") ?? "unknown";
  const rawRealName = readString(raw, "real_name")?.trim() ?? "";
  const rawDisplayName =
    readString(profile, "display_name")?.trim() ?? readString(profile, "display_name_normalized")?.trim() ?? "";
  const realName = rawRealName || rawDisplayName || name;
  const displayName = rawDisplayName || realName;
  const updated = raw.updated;
  return {
    ...(id ? { slackUserId: id } : {}),
    name,
    realName,
    displayName,
    email: readString(profile, "email"),
    phone: readString(profile, "phone"),
    profileTeamId: readString(raw, "team_id"),
    isBot: readBoolean(raw, "is_bot") || id === "USLACKBOT" || readBoolean(raw, "is_app_user"),
    isGuest: readBoolean(raw, "is_guest"),
    isStranger: readBoolean(raw, "is_stranger"),
    isRestricted: readBoolean(raw, "is_restricted"),
    isUltraRestricted: readBoolean(raw, "is_ultra_restricted"),
    deleted: readBoolean(raw, "deleted"),
    providerUpdatedAt: normalizeSlackProviderUpdatedAt(
      typeof updated === "number" || typeof updated === "string" ? updated : null,
    ),
  };
}

function toCachedUser(user: SlackIndexingUser): CachedUser {
  return {
    name: user.name,
    realName: user.realName,
    email: user.email,
    phone: user.phone,
    tz: null,
    isBot: user.isBot,
    slackUserId: user.slackUserId,
    displayName: user.displayName,
    profileTeamId: user.profileTeamId,
    isGuest: user.isGuest,
    isStranger: user.isStranger,
    isRestricted: user.isRestricted,
    isUltraRestricted: user.isUltraRestricted,
    deleted: user.deleted,
    providerUpdatedAt: user.providerUpdatedAt,
  };
}

function fromCachedUser(user: CachedUser, fallbackId: string): SlackIndexingUser {
  return {
    slackUserId: user.slackUserId ?? fallbackId,
    name: user.name,
    realName: user.realName,
    displayName: user.displayName ?? user.realName,
    email: user.email,
    phone: user.phone ?? null,
    profileTeamId: user.profileTeamId ?? null,
    isBot: user.isBot,
    isGuest: user.isGuest ?? false,
    isStranger: user.isStranger ?? false,
    isRestricted: user.isRestricted ?? false,
    isUltraRestricted: user.isUltraRestricted ?? false,
    deleted: user.deleted ?? false,
    providerUpdatedAt: user.providerUpdatedAt ?? null,
  };
}

export interface SlackIndexingFacade {
  isConfigured(): Promise<boolean>;
  withToken?: (
    token: string,
    options?: { isolatedLimiter?: boolean; onOAuthScopes?: (scopes: string[] | null) => void },
  ) => SlackIndexingFacade;
  listUsersPage?: (cursor?: string) => Promise<SlackIndexingPage<SlackIndexingUser>>;
  listChannelsPage?: (cursor?: string) => Promise<SlackIndexingPage<SlackIndexingChannel>>;
  listChannelMembersPage?: (channelId: string, cursor?: string) => Promise<SlackIndexingPage<string>>;
  iterateUsers(): AsyncIterable<SlackIndexingUser>;
  iterateChannels(): AsyncIterable<SlackIndexingChannel>;
  iterateChannelMembers(channelId: string): AsyncIterable<string>;
  listUsers(): Promise<SlackIndexingUser[]>;
  listChannels(): Promise<SlackIndexingChannel[]>;
  listMemberChannels(): Promise<SlackIndexingChannel[]>;
  listChannelMembers(channelId: string): Promise<string[]>;
  getUserInfo(userId: string, options?: { fresh?: boolean }): Promise<SlackIndexingUser>;
}

async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

export interface CreateSlackIndexingFacadeOptions {
  getBotToken: () => Promise<string | null>;
  userCache?: UserCache;
  userInfoCacheTtlMs?: number;
  clientFactory?: (token: string) => SlackIndexingClient;
  limiter?: SlackApiLimiter;
  onOAuthScopes?: (scopes: string[] | null) => void;
}

export function createSettingsBackedSlackIndexingFacade(options: {
  db: Kysely<DB>;
  encryptionKey?: string;
  userCache?: UserCache;
  userInfoCacheTtlMs?: number;
  onOAuthScopes?: (scopes: string[] | null) => void;
}): SlackIndexingFacade {
  const settingsRepo = createSettingsRepository(options.db, options.encryptionKey);
  return createSlackIndexingFacade({
    getBotToken: async () => (await settingsRepo.get())?.slack_bot_token ?? null,
    userCache: options.userCache,
    userInfoCacheTtlMs: options.userInfoCacheTtlMs,
    onOAuthScopes: options.onOAuthScopes,
  });
}

export function createSlackIndexingFacade(options: CreateSlackIndexingFacadeOptions): SlackIndexingFacade {
  return createSlackIndexingFacadeWithState(options, {
    userCache: options.userCache ?? new SlackUserCache(options.userInfoCacheTtlMs),
    clientFactory: options.clientFactory ?? defaultClientFactory,
    limiter: options.limiter,
    connections: new Map(),
    currentToken: null,
    oauthScopeCapture: { scopes: null, observed: false },
  });
}

type SlackIndexingFacadeState = {
  userCache: UserCache;
  clientFactory: (token: string) => SlackIndexingClient;
  limiter?: SlackApiLimiter;
  connections: Map<string, SlackIndexingClient>;
  currentToken: string | null;
  oauthScopeCapture: { scopes: string[] | null; observed: boolean };
};

function createSlackIndexingFacadeWithState(
  options: CreateSlackIndexingFacadeOptions,
  state: SlackIndexingFacadeState,
): SlackIndexingFacade {
  const { userCache } = state;

  async function getConnection(): Promise<{
    client: SlackIndexingClient;
    limiter: SlackApiLimiter;
    oauthScopeCapture: { scopes: string[] | null; observed: boolean };
  }> {
    const token = await options.getBotToken();
    if (!token) throw new Error("Slack indexing facade has no bot token configured");
    if (state.currentToken && state.currentToken !== token) {
      const previous = sharedConnectionsByToken.get(state.currentToken);
      previous?.owners.delete(state);
      if (previous?.owners.size === 0) sharedConnectionsByToken.delete(state.currentToken);
      state.connections.delete(state.currentToken);
      state.oauthScopeCapture = { scopes: null, observed: false };
    }
    state.currentToken = token;
    if (state.limiter) {
      const existing = state.connections.get(token);
      if (existing) return { client: existing, limiter: state.limiter, oauthScopeCapture: state.oauthScopeCapture };
      const next = state.clientFactory(token);
      state.connections.set(token, next);
      return { client: next, limiter: state.limiter, oauthScopeCapture: state.oauthScopeCapture };
    }
    const shared = sharedConnectionsByToken.get(token);
    if (shared && shared.clientFactory === state.clientFactory) {
      shared.owners.add(state);
      return { client: shared.client, limiter: shared.limiter, oauthScopeCapture: shared.oauthScopeCapture };
    }
    const next = {
      client: state.clientFactory(token),
      limiter: new SerializedSlackApiLimiter(),
      clientFactory: state.clientFactory,
      owners: new Set([state]),
      oauthScopeCapture: { scopes: null, observed: false },
    };
    sharedConnectionsByToken.set(token, next);
    return { client: next.client, limiter: next.limiter, oauthScopeCapture: next.oauthScopeCapture };
  }

  async function request<T>(operation: (api: SlackIndexingClient) => Promise<T>): Promise<T> {
    const current = await getConnection();
    return current.limiter.run(() => operation(current.client));
  }

  async function fetchUserInfo(userId: string): Promise<SlackIndexingUser> {
    return mapUser((await request((api) => api.users.info({ user: userId }))).user, userId);
  }

  async function listUsersPage(cursor?: string): Promise<SlackIndexingPage<SlackIndexingUser>> {
    const current = await getConnection();
    const result = await current.limiter.run(() =>
      current.client.users.list({ limit: SLACK_PAGE_LIMIT, ...(cursor ? { cursor } : {}) }),
    );
    const scopes = readOAuthScopes(result.response_metadata);
    if (!current.oauthScopeCapture.observed && scopes !== null) {
      current.oauthScopeCapture.observed = true;
      current.oauthScopeCapture.scopes = scopes;
      options.onOAuthScopes?.(scopes);
    }
    return {
      items: (result.members ?? []).map((member) => mapUser(member)),
      nextCursor: result.response_metadata?.next_cursor || null,
    };
  }

  async function listChannelsPage(cursor?: string): Promise<SlackIndexingPage<SlackIndexingChannel>> {
    const result = await request((api) =>
      api.conversations.list({
        exclude_archived: true,
        limit: SLACK_PAGE_LIMIT,
        types: "public_channel,private_channel",
        ...(cursor ? { cursor } : {}),
      }),
    );
    const items: SlackIndexingChannel[] = [];
    for (const channel of result.channels ?? []) {
      const raw = readRecord(channel);
      const id = readString(raw, "id");
      if (!id) continue;
      items.push({
        id,
        name: readString(raw, "name") ?? "unknown",
        isMember: readBoolean(raw, "is_member"),
        isPrivate: readBoolean(raw, "is_private"),
        isArchived: readBoolean(raw, "is_archived"),
      });
    }
    return { items, nextCursor: result.response_metadata?.next_cursor || null };
  }

  async function listChannelMembersPage(channelId: string, cursor?: string): Promise<SlackIndexingPage<string>> {
    const result = await request((api) =>
      api.conversations.members({ channel: channelId, limit: SLACK_PAGE_LIMIT, ...(cursor ? { cursor } : {}) }),
    );
    return {
      items: (result.members ?? []).filter((member): member is string => typeof member === "string"),
      nextCursor: result.response_metadata?.next_cursor || null,
    };
  }

  async function* iterateUsers(): AsyncIterable<SlackIndexingUser> {
    let cursor: string | undefined;
    do {
      const page = await listUsersPage(cursor);
      for (const member of page.items) yield member;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async function* iterateChannels(): AsyncIterable<SlackIndexingChannel> {
    let cursor: string | undefined;
    do {
      const page = await listChannelsPage(cursor);
      for (const channel of page.items) yield channel;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async function* iterateChannelMembers(channelId: string): AsyncIterable<string> {
    let cursor: string | undefined;
    do {
      const page = await listChannelMembersPage(channelId, cursor);
      for (const member of page.items) yield member;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  return {
    async isConfigured() {
      return Boolean(await options.getBotToken());
    },

    withToken(token, tokenOptions) {
      const onOAuthScopes = tokenOptions?.onOAuthScopes ?? options.onOAuthScopes;
      if (tokenOptions?.isolatedLimiter) {
        return createSlackIndexingFacadeWithState(
          { getBotToken: async () => token, onOAuthScopes },
          {
            userCache: state.userCache,
            clientFactory: state.clientFactory,
            limiter: new SerializedSlackApiLimiter(),
            connections: new Map(),
            currentToken: null,
            oauthScopeCapture: { scopes: null, observed: false },
          },
        );
      }
      return createSlackIndexingFacadeWithState({ getBotToken: async () => token, onOAuthScopes }, state);
    },

    listUsersPage,
    listChannelsPage,
    listChannelMembersPage,
    iterateUsers,
    iterateChannels,
    iterateChannelMembers,

    async listUsers() {
      return collectAsync(iterateUsers());
    },

    async listChannels() {
      return collectAsync(iterateChannels());
    },

    async listMemberChannels() {
      const channels: SlackIndexingChannel[] = [];
      for await (const channel of iterateChannels()) {
        if (channel.isMember) channels.push(channel);
      }
      return channels;
    },

    async listChannelMembers(channelId: string) {
      return collectAsync(iterateChannelMembers(channelId));
    },

    async getUserInfo(userId: string, options?: { fresh?: boolean }) {
      const cached = options?.fresh
        ? await userCache.refresh(userId, async (id) => toCachedUser(await fetchUserInfo(id)))
        : await userCache.resolve(userId, async (id) => toCachedUser(await fetchUserInfo(id)));
      return fromCachedUser(cached, userId);
    },
  };
}
