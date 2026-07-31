import type { Kysely } from "kysely";
import { createSlackChannelParticipantsRepository } from "../db/repositories/slack-channel-participants";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import type { SlackBot } from "./bot";

export const SLACK_MEMBERSHIP_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SLACK_MEMBERSHIP_FRESHNESS_MS = 48 * 60 * 60 * 1000;

export class SlackMembershipReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private rerunRequested = false;
  private readonly participants;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      logger: Pick<Logger, "info" | "warn">;
      getSlack: () => Pick<SlackBot, "listChannelMembers"> | null;
      intervalMs?: number;
    },
  ) {
    this.participants = createSlackChannelParticipantsRepository(deps.db);
  }

  start(): void {
    if (this.timer) return;
    const startWake = () => {
      void this.wake().catch((err) => {
        this.deps.logger.warn({ err }, "Slack membership reconciliation failed");
      });
    };
    this.timer = setInterval(startWake, this.deps.intervalMs ?? SLACK_MEMBERSHIP_RECONCILIATION_INTERVAL_MS);
    this.timer.unref();
    startWake();
  }

  wake(): Promise<void> {
    if (this.pending) {
      this.rerunRequested = true;
      return this.pending;
    }
    this.pending = (async () => {
      do {
        this.rerunRequested = false;
        await this.run();
      } while (this.rerunRequested);
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const slack = this.deps.getSlack();
    if (!slack) return;
    const rows = await this.deps.db
      .selectFrom("conversations")
      .select("provider_conversation_id")
      .distinct()
      .where("platform", "=", "slack")
      .where("kind", "=", "channel")
      .orderBy("provider_conversation_id", "asc")
      .execute();
    let refreshed = 0;
    for (const row of rows) {
      try {
        const members = await slack.listChannelMembers(row.provider_conversation_id);
        if (members.length === 0) {
          this.deps.logger.warn(
            { channelId: row.provider_conversation_id },
            "Skipped empty Slack channel participant refresh",
          );
          continue;
        }
        await this.participants.replaceChannelRoster(row.provider_conversation_id, members, new Date().toISOString());
        refreshed += 1;
      } catch (err) {
        this.deps.logger.warn(
          { err, channelId: row.provider_conversation_id },
          "Slack channel participant refresh failed",
        );
      }
    }
    this.deps.logger.info(
      { eligibleChannels: rows.length, refreshedChannels: refreshed },
      "Slack membership reconciled",
    );
  }
}
