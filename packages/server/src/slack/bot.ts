/**
 * Slack adapter wrapping @slack/bolt in Socket Mode or HTTP mode.
 *
 * Three event paths:
 * - DMs: `message` event with channel_type "im" → onMessage handler
 * - Channel @mentions: `app_mention` event → onChannelMention handler
 * - Passive thread messages: `message` event with thread_ts in a channel →
 *   onThreadMessage handler (buffered for context, no agent run)
 *
 * Bot self-ID resolved at startup via auth.test. Used for mention stripping
 * and to filter out our own messages while letting other bots' messages through.
 *
 * In HTTP mode, Bolt's WebSocket connection is skipped; events arrive via
 * processHttpRequest() which verifies the Slack signature and dispatches
 * to the Bolt app.
 */
import { App, verifySlackRequest } from "@slack/bolt";
import type { Receiver } from "@slack/bolt";
import type { Logger } from "../logger";

const SLACK_LOADING_MESSAGE_LIMIT = 50;

export function parseSlackHttpBody(rawBody: string, contentType: string | undefined): Record<string, unknown> {
  const isFormEncoded = contentType?.toLowerCase().includes("application/x-www-form-urlencoded");
  if (!isFormEncoded) return JSON.parse(rawBody);
  const payload = new URLSearchParams(rawBody).get("payload");
  if (!payload) throw new Error("Form-encoded Slack request missing 'payload' field");
  return JSON.parse(payload);
}

export function clipForSlackLoading(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= SLACK_LOADING_MESSAGE_LIMIT) return text;
  return `${codePoints.slice(0, SLACK_LOADING_MESSAGE_LIMIT - 1).join("")}…`;
}

/**
 * No-op Receiver used in HTTP mode. Bolt requires a receiver instance but we
 * handle event ingestion ourselves via processHttpRequest().
 */
class NoOpReceiver implements Receiver {
  init(): void {}
  async start(): Promise<unknown> {
    return undefined;
  }
  async stop(): Promise<unknown> {
    return undefined;
  }
}

export interface SlackFile {
  name: string;
  urlPrivate: string;
  mimetype: string;
  size: number;
}

/** Shape of file objects in raw Slack message events (not typed by Bolt SDK). */
interface RawSlackFile {
  name?: string;
  url_private_download?: string;
  url_private?: string;
  mimetype?: string;
  size?: number;
}

export interface SlackMessage {
  text: string;
  userId?: string;
  botId?: string;
  appId?: string;
  subtype?: string;
  channelId: string;
  ts: string;
  type: "dm" | "channel_message" | "channel_mention" | "thread_message";
  threadTs?: string;
  files?: SlackFile[];
  /** Slack event channel_type ("channel" | "group" | "mpim" | "im"); lets capture distinguish group DMs from channels. */
  channelType?: string;
  teamId?: string;
}

export type SlackMessageHandler = (message: SlackMessage) => Promise<void>;

export interface AppHomeOpenedEvent {
  slackUserId: string;
}

export type AppHomeOpenedHandler = (event: AppHomeOpenedEvent) => Promise<void>;

export interface HomeActionEvent {
  slackUserId: string;
  actionId: string;
  value: string;
}

export type HomeActionHandler = (event: HomeActionEvent) => Promise<void>;

export interface SlackChannelMembershipEvent {
  channelId: string;
  slackUserId: string;
  teamId?: string;
  isBot?: boolean;
}

export type SlackChannelMembershipHandler = (event: SlackChannelMembershipEvent) => Promise<void>;

export interface SlackUserLifecycleEvent {
  teamId?: string;
  slackUserId: string;
}

export type SlackUserLifecycleHandler = (event: SlackUserLifecycleEvent) => Promise<void>;

export interface SlackBotConfig {
  mode: "socket" | "http";
  botToken: string;
  logger: Logger;
  appToken?: string; // Required for socket mode
  signingSecret?: string; // Required for http mode
  onTeamIdResolved?: (teamId: string) => Promise<void>;
  eventSilenceThresholdMs?: number;
}

/**
 * Channel-membership system messages that Slack delivers with a `user` field,
 * so they pass the human-sender gate and would otherwise be captured as
 * conversation content. Exact blocklist rather than "any subtype": user
 * content subtypes like `file_share` and `thread_broadcast` must keep flowing.
 */
export const SYSTEM_MESSAGE_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_posting_permissions",
]);

export class SlackBot {
  private app: App;
  private logger: Logger;
  private mode: "socket" | "http";
  private signingSecret: string | undefined;
  private onTeamIdResolved: ((teamId: string) => Promise<void>) | undefined;
  private eventSilenceThresholdMs: number;
  private handler: SlackMessageHandler | null = null;
  private channelMessageHandler: SlackMessageHandler | null = null;
  private mentionHandler: SlackMessageHandler | null = null;
  private threadMessageHandler: SlackMessageHandler | null = null;
  private channelRenamedHandler: ((channelId: string) => Promise<void>) | null = null;
  private memberJoinedChannelHandler: SlackChannelMembershipHandler | null = null;
  private memberLeftChannelHandler: SlackChannelMembershipHandler | null = null;
  private teamJoinHandler: SlackUserLifecycleHandler | null = null;
  private userChangeHandler: SlackUserLifecycleHandler | null = null;
  private appHomeOpenedHandler: AppHomeOpenedHandler | null = null;
  private homeActionHandler: HomeActionHandler | null = null;
  private botUserId: string | null = null;
  private botId: string | null = null;
  private teamId: string | null = null;
  private seenEvents = new Map<string, number>();
  private seenEventsTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleEventLastSeen = new Map<"team_join" | "user_change", number>();
  private lifecycleEventWarnings = new Set<"team_join" | "user_change">();
  private lifecycleEventTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SlackBotConfig) {
    this.logger = config.logger;
    this.mode = config.mode;
    this.signingSecret = config.signingSecret;
    this.onTeamIdResolved = config.onTeamIdResolved;
    this.eventSilenceThresholdMs = config.eventSilenceThresholdMs ?? 7 * 24 * 60 * 60 * 1000;

    if (config.mode === "socket") {
      if (!config.appToken) {
        throw new Error("SlackBot socket mode requires appToken");
      }
      this.app = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
      });
    } else {
      if (!config.signingSecret) {
        throw new Error("SlackBot http mode requires signingSecret");
      }
      this.app = new App({
        token: config.botToken,
        receiver: new NoOpReceiver(),
      });
      this.seenEventsTimer = setInterval(
        () => {
          const cutoff = Date.now() - 5 * 60 * 1000;
          for (const [id, ts] of this.seenEvents) {
            if (ts < cutoff) this.seenEvents.delete(id);
          }
        },
        2 * 60 * 1000,
      );
    }
  }

  static stripBotMention(text: string, botUserId: string): string {
    return text
      .replace(new RegExp(`<@${botUserId}>`, "g"), "")
      .replace(/\s+/g, " ")
      .trim();
  }

  onMessage(handler: SlackMessageHandler): void {
    this.handler = handler;
  }

  onChannelMessage(handler: SlackMessageHandler): void {
    this.channelMessageHandler = handler;
  }

  onChannelMention(handler: SlackMessageHandler): void {
    this.mentionHandler = handler;
  }

  onThreadMessage(handler: SlackMessageHandler): void {
    this.threadMessageHandler = handler;
  }

  onChannelRenamed(handler: (channelId: string) => Promise<void>): void {
    this.channelRenamedHandler = handler;
  }

  onMemberJoinedChannel(handler: SlackChannelMembershipHandler): void {
    this.memberJoinedChannelHandler = handler;
  }

  onMemberLeftChannel(handler: SlackChannelMembershipHandler): void {
    this.memberLeftChannelHandler = handler;
  }

  onTeamJoin(handler: SlackUserLifecycleHandler): void {
    this.teamJoinHandler = handler;
  }

  onUserChange(handler: SlackUserLifecycleHandler): void {
    this.userChangeHandler = handler;
  }

  onAppHomeOpened(handler: AppHomeOpenedHandler): void {
    this.appHomeOpenedHandler = handler;
  }

  onHomeAction(handler: HomeActionHandler): void {
    this.homeActionHandler = handler;
  }

  async start(): Promise<void> {
    const auth = await this.app.client.auth.test();
    if (!auth.team_id) throw new Error("Slack auth.test did not return a team id");
    this.teamId = auth.team_id;
    await this.onTeamIdResolved?.(this.teamId);
    this.botUserId = auth.user_id ?? null;
    this.botId = "bot_id" in auth && typeof auth.bot_id === "string" ? auth.bot_id : null;
    this.logger.info({ botUserId: this.botUserId, botId: this.botId }, "Resolved bot IDs");
    const startedAt = Date.now();
    this.lifecycleEventLastSeen = new Map([
      ["team_join", startedAt],
      ["user_change", startedAt],
    ]);
    this.lifecycleEventWarnings.clear();
    this.lifecycleEventTimer = setInterval(
      () => this.warnOnSilentLifecycleEvents(),
      Math.min(this.eventSilenceThresholdMs, 60_000),
    );
    this.lifecycleEventTimer.unref?.();

    this.app.message(async ({ message }) => {
      const userId = "user" in message && typeof message.user === "string" ? message.user : undefined;
      const botId = "bot_id" in message && typeof message.bot_id === "string" ? message.bot_id : undefined;
      const appId = "app_id" in message && typeof message.app_id === "string" ? message.app_id : undefined;
      const subtype = "subtype" in message && typeof message.subtype === "string" ? message.subtype : undefined;
      const teamId = "team" in message && typeof message.team === "string" ? message.team : (this.teamId ?? undefined);
      if (!userId && !botId) return;
      if (userId === this.botUserId || botId === this.botId) return;

      const isIm = "channel_type" in message && message.channel_type === "im";
      const channelType =
        "channel_type" in message && typeof message.channel_type === "string" ? message.channel_type : undefined;
      const threadTs = "thread_ts" in message ? (message.thread_ts as string) : undefined;
      const text = "text" in message && typeof message.text === "string" ? message.text : "";
      const mentionsBot = this.botUserId ? text.includes(`<@${this.botUserId}>`) : false;

      if (isIm) {
        if (!userId || !this.handler) return;

        const hasText = "text" in message && message.text;
        const rawFiles = "files" in message && Array.isArray(message.files) ? message.files : [];
        const hasFiles = rawFiles.length > 0;
        if (!hasText && !hasFiles) return;

        const files: SlackFile[] = (rawFiles as RawSlackFile[]).map((f) => ({
          name: f.name || "file",
          urlPrivate: f.url_private_download || f.url_private || "",
          mimetype: f.mimetype || "application/octet-stream",
          size: f.size || 0,
        }));

        await this.handler({
          type: "dm",
          text: hasText ? (message as { text: string }).text : "",
          ...(userId ? { userId } : {}),
          ...(botId ? { botId } : {}),
          ...(appId ? { appId } : {}),
          ...(subtype ? { subtype } : {}),
          channelId: message.channel,
          ts: message.ts,
          ...(threadTs ? { threadTs } : {}),
          ...(files.length > 0 && { files }),
          ...(teamId ? { teamId } : {}),
        });
        return;
      }

      if (mentionsBot) return;

      if ("subtype" in message && typeof message.subtype === "string" && SYSTEM_MESSAGE_SUBTYPES.has(message.subtype)) {
        /**
         * Renames are excluded from capture but must still refresh stored
         * channel metadata, or slice filenames and rosters keep advertising
         * the old name forever.
         */
        if (message.subtype === "channel_name" && this.channelRenamedHandler) {
          try {
            await this.channelRenamedHandler(message.channel);
          } catch (err) {
            this.logger.warn({ err, channelId: message.channel }, "Channel rename refresh failed");
          }
        }
        return;
      }

      if (threadTs && this.threadMessageHandler) {
        if (!userId) return;
        const hasText = text.length > 0;
        const rawFiles = "files" in message && Array.isArray(message.files) ? message.files : [];
        const hasFiles = rawFiles.length > 0;
        if (!hasText && !hasFiles) return;

        const files: SlackFile[] = (rawFiles as RawSlackFile[]).map((f) => ({
          name: f.name || "file",
          urlPrivate: f.url_private_download || f.url_private || "",
          mimetype: f.mimetype || "application/octet-stream",
          size: f.size || 0,
        }));

        await this.threadMessageHandler({
          type: "thread_message",
          text,
          ...(userId ? { userId } : {}),
          ...(botId ? { botId } : {}),
          ...(appId ? { appId } : {}),
          ...(subtype ? { subtype } : {}),
          channelId: message.channel,
          ts: message.ts,
          threadTs,
          ...(channelType ? { channelType } : {}),
          ...(files.length > 0 && { files }),
          ...(teamId ? { teamId } : {}),
        });
        return;
      }

      if (this.channelMessageHandler) {
        const hasText = text.length > 0;
        const rawFiles = "files" in message && Array.isArray(message.files) ? message.files : [];
        const hasFiles = rawFiles.length > 0;
        if (!hasText && !hasFiles) return;

        const files: SlackFile[] = (rawFiles as RawSlackFile[]).map((f) => ({
          name: f.name || "file",
          urlPrivate: f.url_private_download || f.url_private || "",
          mimetype: f.mimetype || "application/octet-stream",
          size: f.size || 0,
        }));

        await this.channelMessageHandler({
          type: "channel_message",
          ...(channelType ? { channelType } : {}),
          text,
          ...(userId ? { userId } : {}),
          ...(botId ? { botId } : {}),
          ...(appId ? { appId } : {}),
          ...(subtype ? { subtype } : {}),
          channelId: message.channel,
          ts: message.ts,
          ...(files.length > 0 && { files }),
          ...(teamId ? { teamId } : {}),
        });
      }
    });

    this.app.event("app_mention", async ({ event }) => {
      if (!this.mentionHandler) return;
      if (!event.user) return;

      const mentionTeamId = (event as { team_id?: string }).team_id ?? this.teamId ?? undefined;
      if (!this.isEventForActiveTeam(mentionTeamId)) return;

      const hasText = event.text;
      const rawFiles = "files" in event && Array.isArray(event.files) ? event.files : [];
      const hasFiles = rawFiles.length > 0;

      const cleanText = hasText ? SlackBot.stripBotMention(event.text, this.botUserId ?? "") : "";
      if (!cleanText && !hasFiles) return;

      const files: SlackFile[] = (rawFiles as RawSlackFile[]).map((f) => ({
        name: f.name || "file",
        urlPrivate: f.url_private_download || f.url_private || "",
        mimetype: f.mimetype || "application/octet-stream",
        size: f.size || 0,
      }));

      await this.mentionHandler({
        type: "channel_mention",
        text: cleanText,
        userId: event.user,
        channelId: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        ...(mentionTeamId ? { teamId: mentionTeamId } : {}),
        ...(files.length > 0 && { files }),
      });
    });

    this.app.event("app_home_opened", async ({ event }) => {
      if (!this.appHomeOpenedHandler) return;
      const tab = (event as { tab?: string }).tab;
      if (tab && tab !== "home") return;
      const userId = (event as { user?: string }).user;
      if (!userId) return;
      try {
        await this.appHomeOpenedHandler({ slackUserId: userId });
      } catch (err) {
        this.logger.warn({ err, slackUserId: userId }, "app_home_opened handler failed");
      }
    });

    this.app.event("member_joined_channel", async ({ event }) => {
      if (!this.memberJoinedChannelHandler) return;
      const membership = event as { channel?: string; user?: string; team_id?: string };
      if (!membership.channel || !membership.user) return;
      const teamId = membership.team_id ?? this.teamId ?? undefined;
      if (!this.isEventForActiveTeam(teamId)) return;
      try {
        await this.memberJoinedChannelHandler({
          channelId: membership.channel,
          slackUserId: membership.user,
          ...(teamId ? { teamId } : {}),
          ...(membership.user === this.botUserId ? { isBot: true } : {}),
        });
      } catch (err) {
        this.logger.warn(
          { err, channelId: membership.channel, slackUserId: membership.user },
          "Slack member join persistence failed",
        );
      }
    });

    this.app.event("member_left_channel", async ({ event }) => {
      if (!this.memberLeftChannelHandler) return;
      const membership = event as { channel?: string; user?: string; team_id?: string };
      if (!membership.channel || !membership.user) return;
      const teamId = membership.team_id ?? this.teamId ?? undefined;
      if (!this.isEventForActiveTeam(teamId)) return;
      try {
        await this.memberLeftChannelHandler({
          channelId: membership.channel,
          slackUserId: membership.user,
          ...(teamId ? { teamId } : {}),
        });
      } catch (err) {
        this.logger.warn(
          { err, channelId: membership.channel, slackUserId: membership.user },
          "Slack member leave persistence failed",
        );
      }
    });

    this.app.event("team_join", async ({ event }) => {
      const payload = event as { team_id?: string; user?: { id?: string } | string };
      const teamId = payload.team_id ?? this.teamId ?? undefined;
      if (!this.isEventForActiveTeam(teamId)) return;
      this.markLifecycleEventSeen("team_join");
      const slackUserId = typeof payload.user === "string" ? payload.user : payload.user?.id;
      if (!slackUserId || !this.teamJoinHandler) return;
      try {
        await this.teamJoinHandler({
          slackUserId,
          ...(teamId ? { teamId } : {}),
        });
      } catch (err) {
        this.logger.warn({ err, slackUserId }, "Slack team_join entity sync failed");
      }
    });

    this.app.event("user_change", async ({ event }) => {
      const payload = event as { team_id?: string; user?: { id?: string; team_id?: string } | string };
      const nestedUser = typeof payload.user === "object" && payload.user ? payload.user : null;
      const teamId = payload.team_id ?? nestedUser?.team_id ?? this.teamId ?? undefined;
      if (!this.isEventForActiveTeam(teamId)) return;
      this.markLifecycleEventSeen("user_change");
      const slackUserId = typeof payload.user === "string" ? payload.user : nestedUser?.id;
      if (!slackUserId || !this.userChangeHandler) return;
      try {
        await this.userChangeHandler({
          slackUserId,
          ...(teamId ? { teamId } : {}),
        });
      } catch (err) {
        this.logger.warn({ err, slackUserId }, "Slack user_change entity sync failed");
      }
    });

    this.app.action(/^home:.+/, async ({ body, action, ack }) => {
      await ack();
      if (!this.homeActionHandler) return;
      const slackUserId = (body as { user?: { id?: string } }).user?.id;
      if (!slackUserId) return;
      const actionId = (action as { action_id?: string }).action_id ?? "";
      const selected = (action as { selected_option?: { value?: string } }).selected_option;
      const value = selected?.value ?? (action as { value?: string }).value ?? "";
      try {
        await this.homeActionHandler({ slackUserId, actionId, value });
      } catch (err) {
        this.logger.warn({ err, slackUserId, actionId }, "home action handler failed");
      }
    });

    if (this.mode === "socket") {
      await this.app.start();
      this.logger.info("Slack bot connected (Socket Mode)");
    } else {
      this.logger.info("Slack bot ready (HTTP Mode)");
    }
  }

  /**
   * Verifies the Slack request signature, then dispatches the event to the Bolt
   * app. Used in HTTP mode where events arrive via POST /slack/events instead of
   * a WebSocket connection.
   */
  async processHttpRequest(rawBody: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const timestamp = headers["x-slack-request-timestamp"];
    const signature = headers["x-slack-signature"];

    if (!timestamp || !signature) {
      throw new Error("Missing Slack signature headers");
    }

    verifySlackRequest({
      signingSecret: this.signingSecret ?? "",
      body: rawBody,
      headers: {
        "x-slack-signature": signature,
        "x-slack-request-timestamp": Number(timestamp),
      },
    });

    const body = parseSlackHttpBody(rawBody, headers["content-type"]);

    if (body.type === "url_verification") {
      return { challenge: body.challenge };
    }

    if (body.type === "ssl_check") {
      return {};
    }

    const eventId = body.event_id as string | undefined;
    if (eventId) {
      if (this.seenEvents.has(eventId)) {
        this.logger.debug({ eventId }, "Duplicate Slack event, skipping");
        return {};
      }
      this.seenEvents.set(eventId, Date.now());
    }

    // processEvent dispatches to registered handlers. Errors (e.g. auth failures
    // from Bolt's internal authorization) are logged but not surfaced to the
    // caller — the HTTP 200 has already been committed by the time handlers run.
    this.app
      .processEvent({
        body,
        ack: async () => {},
      })
      .catch((err) => {
        this.logger.warn({ err }, "Slack processEvent error");
      });

    return {};
  }

  async postMessage(channelId: string, text: string): Promise<string> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text,
    });
    return result.ts ?? "";
  }

  async postThreadReply(channelId: string, threadTs: string, text: string): Promise<string> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
    });
    return result.ts ?? "";
  }

  async updateMessage(channelId: string, ts: string, text: string): Promise<void> {
    await this.app.client.chat.update({
      channel: channelId,
      ts,
      text,
    });
  }

  async setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    try {
      await this.app.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: status ? "is thinking..." : "",
        ...(status ? { loading_messages: [clipForSlackLoading(status)] } : {}),
      });
    } catch (err) {
      this.logger.warn({ err, channelId, threadTs }, "Slack assistant.threads.setStatus failed");
    }
  }

  async publishHomeView(slackUserId: string, view: { type: "home"; blocks: Record<string, unknown>[] }): Promise<void> {
    try {
      await this.app.client.views.publish({
        user_id: slackUserId,
        view: view as unknown as Parameters<typeof this.app.client.views.publish>[0]["view"],
      });
    } catch (err) {
      this.logger.warn({ err, slackUserId }, "Slack views.publish failed");
    }
  }

  async addReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.add({ channel: channelId, timestamp: ts, name: emoji });
    } catch (err) {
      this.logger.warn({ err, emoji }, "Slack reactions.add failed");
    }
  }

  async removeReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.remove({ channel: channelId, timestamp: ts, name: emoji });
    } catch (err) {
      this.logger.warn({ err, emoji }, "Slack reactions.remove failed");
    }
  }

  async getUserInfo(
    userId: string,
  ): Promise<{ name: string; realName: string; email: string | null; tz: string | null; isBot: boolean }> {
    const result = await this.app.client.users.info({ user: userId });
    return {
      name: result.user?.name ?? "unknown",
      realName: result.user?.real_name ?? result.user?.name ?? "unknown",
      email: result.user?.profile?.email ?? null,
      tz: result.user?.tz ?? null,
      isBot: result.user?.is_bot === true || userId === "USLACKBOT",
    };
  }

  async getChannelInfo(channelId: string): Promise<{ name: string; type: string }> {
    const result = await this.app.client.conversations.info({ channel: channelId });
    const channel = result.channel;
    let type = "public_channel";
    if (channel?.is_mpim) type = "mpim";
    else if (channel?.is_group) type = "group";
    else if (channel?.is_private) type = "private_channel";
    return {
      name: channel?.name ?? "unknown",
      type,
    };
  }

  async listChannels(): Promise<Array<{ id: string; name: string; type: string; isMember: boolean }>> {
    const channels: Array<{ id: string; name: string; type: string; isMember: boolean }> = [];
    let cursor: string | undefined;
    do {
      const result = await this.app.client.conversations.list({
        exclude_archived: true,
        limit: 200,
        types: "public_channel,private_channel",
        ...(cursor ? { cursor } : {}),
      });
      for (const channel of result.channels ?? []) {
        if (!channel.id) continue;
        channels.push({
          id: channel.id,
          name: channel.name ?? "unknown",
          type: channel.is_private ? "private_channel" : "public_channel",
          isMember: channel.is_member === true,
        });
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channels;
  }

  async isUserInChannel(channelId: string, slackUserId: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const result = await this.app.client.conversations.members({
        channel: channelId,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      if ((result.members ?? []).includes(slackUserId)) return true;
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return false;
  }

  async listChannelMembers(channelId: string): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.app.client.conversations.members({
        channel: channelId,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      members.push(...(result.members ?? []));
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return [...new Set(members)];
  }

  async getChannelHistory(channelId: string, limit = 5): Promise<Array<{ userId: string; text: string; ts: string }>> {
    const result = await this.app.client.conversations.history({ channel: channelId, limit });
    return (result.messages ?? [])
      .filter((m) => m.text && m.user)
      .map((m) => ({
        userId: m.user as string,
        text: m.text as string,
        ts: m.ts as string,
      }));
  }

  async getThreadReplies(
    channelId: string,
    threadTs: string,
    limit = 50,
  ): Promise<Array<{ userId: string; text: string; ts: string }>> {
    const result = await this.app.client.conversations.replies({ channel: channelId, ts: threadTs, limit });
    return (result.messages ?? [])
      .filter((m) => m.text && m.user)
      .map((m) => ({
        userId: m.user as string,
        text: m.text as string,
        ts: m.ts as string,
      }));
  }

  async openDmChannel(slackUserId: string, botToken?: string): Promise<string | null> {
    const result = await this.app.client.conversations.open({
      ...(botToken ? { token: botToken } : {}),
      users: slackUserId,
    });
    return result.channel?.id ?? null;
  }

  async uploadFile(channelId: string, filePath: string, threadTs?: string): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const { basename } = await import("node:path");
    const content = readFileSync(filePath);
    const filename = basename(filePath);
    await this.app.client.files.uploadV2({
      channel_id: channelId,
      file: content,
      filename,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    } as Parameters<typeof this.app.client.files.uploadV2>[0]);
  }

  async stop(): Promise<void> {
    if (this.seenEventsTimer) clearInterval(this.seenEventsTimer);
    if (this.lifecycleEventTimer) clearInterval(this.lifecycleEventTimer);
    this.seenEventsTimer = null;
    this.lifecycleEventTimer = null;
    await this.app.stop();
  }

  private isEventForActiveTeam(teamId: string | undefined): boolean {
    if (!teamId || !this.teamId || teamId === this.teamId) return true;
    this.logger.warn({ eventTeamId: teamId, activeTeamId: this.teamId }, "Dropped Slack event from another team");
    return false;
  }

  private markLifecycleEventSeen(eventType: "team_join" | "user_change"): void {
    this.lifecycleEventLastSeen.set(eventType, Date.now());
    this.lifecycleEventWarnings.delete(eventType);
  }

  private warnOnSilentLifecycleEvents(): void {
    const now = Date.now();
    for (const eventType of ["team_join", "user_change"] as const) {
      const lastSeen = this.lifecycleEventLastSeen.get(eventType) ?? now;
      if (now - lastSeen < this.eventSilenceThresholdMs || this.lifecycleEventWarnings.has(eventType)) continue;
      this.lifecycleEventWarnings.add(eventType);
      this.logger.warn(
        {
          eventType,
          teamId: this.teamId,
          silentForMs: now - lastSeen,
          thresholdMs: this.eventSilenceThresholdMs,
        },
        "Slack lifecycle event has been silent; update the Slack app manifest",
      );
    }
  }
}
