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
  profileTeamId?: string | null;
  isBot: boolean;
  isGuest?: boolean;
  isStranger?: boolean;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
  deleted?: boolean;
  providerUpdatedAt?: string | null;
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
    profileTeamId: readString(raw, "team_id"),
    isBot: readBoolean(raw, "is_bot") || id === "USLACKBOT",
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
  iterateUsers(): AsyncIterable<SlackIndexingUser>;
  iterateChannels(): AsyncIterable<SlackIndexingChannel>;
  iterateChannelMembers(channelId: string): AsyncIterable<string>;
  listUsers(): Promise<SlackIndexingUser[]>;
  listChannels(): Promise<SlackIndexingChannel[]>;
  listMemberChannels(): Promise<SlackIndexingChannel[]>;
  listChannelMembers(channelId: string): Promise<string[]>;
  getUserInfo(userId: string): Promise<SlackIndexingUser>;
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
}

export function createSettingsBackedSlackIndexingFacade(options: {
  db: Kysely<DB>;
  encryptionKey?: string;
  userCache?: UserCache;
  userInfoCacheTtlMs?: number;
}): SlackIndexingFacade {
  const settingsRepo = createSettingsRepository(options.db, options.encryptionKey);
  return createSlackIndexingFacade({
    getBotToken: async () => (await settingsRepo.get())?.slack_bot_token ?? null,
    userCache: options.userCache,
    userInfoCacheTtlMs: options.userInfoCacheTtlMs,
  });
}

export function createSlackIndexingFacade(options: CreateSlackIndexingFacadeOptions): SlackIndexingFacade {
  const userCache = options.userCache ?? new SlackUserCache(options.userInfoCacheTtlMs);
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  let connection: { token: string; client: SlackIndexingClient; limiter: SlackApiLimiter } | null = null;

  async function getConnection(): Promise<{ client: SlackIndexingClient; limiter: SlackApiLimiter }> {
    const token = await options.getBotToken();
    if (!token) throw new Error("Slack indexing facade has no bot token configured");
    if (!connection || connection.token !== token) {
      if (options.limiter) {
        connection = { token, client: clientFactory(token), limiter: options.limiter };
      } else {
        const shared = sharedConnectionsByToken.get(token);
        if (shared && shared.clientFactory === clientFactory) {
          connection = { token, client: shared.client, limiter: shared.limiter };
        } else {
          const next = {
            client: clientFactory(token),
            limiter: new SerializedSlackApiLimiter(),
            clientFactory,
          };
          sharedConnectionsByToken.set(token, next);
          connection = { token, client: next.client, limiter: next.limiter };
        }
      }
    }
    return { client: connection.client, limiter: connection.limiter };
  }

  async function request<T>(operation: (api: SlackIndexingClient) => Promise<T>): Promise<T> {
    const current = await getConnection();
    return current.limiter.run(() => operation(current.client));
  }

  async function fetchUserInfo(userId: string): Promise<SlackIndexingUser> {
    return mapUser((await request((api) => api.users.info({ user: userId }))).user, userId);
  }

  async function* iterateUsers(): AsyncIterable<SlackIndexingUser> {
    let cursor: string | undefined;
    do {
      const result = await request((api) => api.users.list({ limit: SLACK_PAGE_LIMIT, ...(cursor ? { cursor } : {}) }));
      for (const member of result.members ?? []) yield mapUser(member);
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  async function* iterateChannels(): AsyncIterable<SlackIndexingChannel> {
    let cursor: string | undefined;
    do {
      const result = await request((api) =>
        api.conversations.list({
          exclude_archived: true,
          limit: SLACK_PAGE_LIMIT,
          types: "public_channel,private_channel",
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const channel of result.channels ?? []) {
        const raw = readRecord(channel);
        const id = readString(raw, "id");
        if (!id) continue;
        yield {
          id,
          name: readString(raw, "name") ?? "unknown",
          isMember: readBoolean(raw, "is_member"),
          isPrivate: readBoolean(raw, "is_private"),
          isArchived: readBoolean(raw, "is_archived"),
        };
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  async function* iterateChannelMembers(channelId: string): AsyncIterable<string> {
    let cursor: string | undefined;
    do {
      const result = await request((api) =>
        api.conversations.members({ channel: channelId, limit: SLACK_PAGE_LIMIT, ...(cursor ? { cursor } : {}) }),
      );
      for (const member of result.members ?? []) {
        if (typeof member === "string") yield member;
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  return {
    async isConfigured() {
      return Boolean(await options.getBotToken());
    },

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

    async getUserInfo(userId: string) {
      const cached = await userCache.resolve(userId, async (id) => toCachedUser(await fetchUserInfo(id)));
      return fromCachedUser(cached, userId);
    },
  };
}
