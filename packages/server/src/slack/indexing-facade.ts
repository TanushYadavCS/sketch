import { WebClient } from "@slack/web-api";
import type { Kysely } from "kysely";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import type { UserCache } from "./user-cache";

export interface SlackIndexingChannel {
  id: string;
  name: string;
}

export interface SlackIndexingUser {
  name: string;
  realName: string;
  email: string | null;
  isBot: boolean;
}

/**
 * Narrow Slack API surface for the indexing connector. The connector must not
 * read encrypted settings or hold the live Bolt instance, so bootstrap injects
 * this facade instead. It is lazy: the token is resolved per call, so live
 * token rotation never leaves a stale client behind.
 */
export interface SlackIndexingFacade {
  /** False while no bot token is configured (Slack disconnected) — callers no-op instead of erroring. */
  isConfigured(): Promise<boolean>;
  listMemberChannels(): Promise<SlackIndexingChannel[]>;
  listChannelMembers(channelId: string): Promise<string[]>;
  getUserInfo(userId: string): Promise<SlackIndexingUser>;
}

export interface CreateSlackIndexingFacadeOptions {
  getBotToken: () => Promise<string | null>;
  userCache?: UserCache;
}

/**
 * Standard facade construction: token resolved from decrypted settings per
 * call, so live token rotation never leaves a stale client. Used by bootstrap
 * (with the shared UserCache) and by the manual-sync API path (uncached).
 */
export function createSettingsBackedSlackIndexingFacade(options: {
  db: Kysely<DB>;
  encryptionKey?: string;
  userCache?: UserCache;
}): SlackIndexingFacade {
  const settingsRepo = createSettingsRepository(options.db, options.encryptionKey);
  return createSlackIndexingFacade({
    getBotToken: async () => (await settingsRepo.get())?.slack_bot_token ?? null,
    userCache: options.userCache,
  });
}

export function createSlackIndexingFacade(options: CreateSlackIndexingFacadeOptions): SlackIndexingFacade {
  async function client(): Promise<WebClient> {
    const token = await options.getBotToken();
    if (!token) throw new Error("Slack indexing facade has no bot token configured");
    return new WebClient(token);
  }

  async function fetchUserInfo(userId: string): Promise<SlackIndexingUser> {
    const api = await client();
    const result = await api.users.info({ user: userId });
    return {
      name: result.user?.name ?? "unknown",
      realName: result.user?.real_name ?? result.user?.name ?? "unknown",
      email: result.user?.profile?.email ?? null,
      isBot: result.user?.is_bot === true || userId === "USLACKBOT",
    };
  }

  return {
    async isConfigured() {
      return (await options.getBotToken()) !== null;
    },

    async listMemberChannels() {
      const api = await client();
      const channels: SlackIndexingChannel[] = [];
      let cursor: string | undefined;
      do {
        const result = await api.conversations.list({
          exclude_archived: true,
          limit: 200,
          types: "public_channel,private_channel",
          ...(cursor ? { cursor } : {}),
        });
        for (const channel of result.channels ?? []) {
          if (channel.id && channel.is_member === true) {
            channels.push({ id: channel.id, name: channel.name ?? "unknown" });
          }
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return channels;
    },

    async listChannelMembers(channelId: string) {
      const api = await client();
      const members: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await api.conversations.members({
          channel: channelId,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        members.push(...(result.members ?? []));
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return members;
    },

    async getUserInfo(userId: string) {
      if (options.userCache) {
        const cached = await options.userCache.resolve(userId, async (id) => {
          const info = await fetchUserInfo(id);
          return { name: info.name, realName: info.realName, email: info.email, tz: null, isBot: info.isBot };
        });
        return { name: cached.name, realName: cached.realName, email: cached.email, isBot: cached.isBot };
      }
      return fetchUserInfo(userId);
    },
  };
}
