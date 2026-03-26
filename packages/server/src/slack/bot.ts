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
  userId: string;
  channelId: string;
  ts: string;
  type: "dm" | "channel_mention" | "thread_message";
  threadTs?: string;
  files?: SlackFile[];
}

export type SlackMessageHandler = (message: SlackMessage) => Promise<void>;

export interface SlackBotConfig {
  mode: "socket" | "http";
  botToken: string;
  logger: Logger;
  appToken?: string; // Required for socket mode
  signingSecret?: string; // Required for http mode
}

export class SlackBot {
  private app: App;
  private logger: Logger;
  private mode: "socket" | "http";
  private signingSecret: string | undefined;
  private handler: SlackMessageHandler | null = null;
  private mentionHandler: SlackMessageHandler | null = null;
  private threadMessageHandler: SlackMessageHandler | null = null;
  private botUserId: string | null = null;

  constructor(config: SlackBotConfig) {
    this.logger = config.logger;
    this.mode = config.mode;
    this.signingSecret = config.signingSecret;

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

  onChannelMention(handler: SlackMessageHandler): void {
    this.mentionHandler = handler;
  }

  onThreadMessage(handler: SlackMessageHandler): void {
    this.threadMessageHandler = handler;
  }

  async start(): Promise<void> {
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id ?? null;
    this.logger.info({ botUserId: this.botUserId }, "Resolved bot user ID");

    this.app.message(async ({ message }) => {
      if (!("user" in message) || !message.user) return;
      if (message.user === this.botUserId) return;

      const isIm = "channel_type" in message && message.channel_type === "im";
      const threadTs = "thread_ts" in message ? (message.thread_ts as string) : undefined;

      if (isIm) {
        if (!this.handler) return;

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
          userId: message.user,
          channelId: message.channel,
          ts: message.ts,
          ...(files.length > 0 && { files }),
        });
        return;
      }

      if (threadTs && this.threadMessageHandler) {
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

        await this.threadMessageHandler({
          type: "thread_message",
          text: hasText ? (message as { text: string }).text : "",
          userId: message.user,
          channelId: message.channel,
          ts: message.ts,
          threadTs,
          ...(files.length > 0 && { files }),
        });
      }
    });

    this.app.event("app_mention", async ({ event }) => {
      if (!this.mentionHandler) return;
      if (!event.user) return;

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
        ...(files.length > 0 && { files }),
      });
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

    const body = JSON.parse(rawBody);

    if (body.type === "url_verification") {
      return { challenge: body.challenge };
    }

    if (body.type === "ssl_check") {
      return {};
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

  async getUserInfo(userId: string): Promise<{ name: string; realName: string; email: string | null }> {
    const result = await this.app.client.users.info({ user: userId });
    return {
      name: result.user?.name ?? "unknown",
      realName: result.user?.real_name ?? result.user?.name ?? "unknown",
      email: result.user?.profile?.email ?? null,
    };
  }

  async getChannelInfo(channelId: string): Promise<{ name: string; type: string }> {
    const result = await this.app.client.conversations.info({ channel: channelId });
    const channel = result.channel;
    let type = "public_channel";
    if (channel?.is_group) type = "group";
    else if (channel?.is_private) type = "private_channel";
    return {
      name: channel?.name ?? "unknown",
      type,
    };
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
    await this.app.stop();
  }
}
