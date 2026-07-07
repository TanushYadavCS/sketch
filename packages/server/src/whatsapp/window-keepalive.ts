import { Cron } from "croner";
import type { Kysely } from "kysely";
import { createConversationRepository } from "../db/repositories/conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { createSettingsRepository } from "../db/repositories/settings";
import { createWhatsAppWindowKeepAliveRepository } from "../db/repositories/whatsapp-window-keepalives";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import type { WhatsAppTarget } from "./provider";
import type { WhatsAppRuntime } from "./runtime";

const KEEPALIVE_CRON = "0 * * * *";
const KEEPALIVE_TIMEZONE = "UTC";
const PING_BAND_START_MS = 21 * 60 * 60 * 1000;
const PING_BAND_END_MS = 23 * 60 * 60 * 1000;
const UPCOMING_TASK_HORIZON_MS = 26 * 60 * 60 * 1000;
const CAPABILITY_TARGET: WhatsAppTarget = { kind: "dm", phoneE164: "+10000000000" };

export type WhatsAppWindowKeepAliveDecision =
  | "send"
  | "skip_no_inbound"
  | "skip_recent"
  | "skip_lapsed"
  | "skip_deduped";

export interface WhatsAppWindowKeepAliveCounts {
  candidates: number;
  pinged: number;
  skipped_recent: number;
  skipped_lapsed: number;
  skipped_deduped: number;
  skipped_no_inbound: number;
  failed: number;
}

export interface WhatsAppWindowKeepAliveDecisionInput {
  latestInboundReceivedAt?: string | null;
  lastKeepAliveSentAt?: string | null;
  now: Date;
}

export interface WhatsAppWindowKeepAliveJobHandle {
  stop(): void;
  runNow(): Promise<WhatsAppWindowKeepAliveCounts | null>;
}

export interface WhatsAppWindowKeepAliveJobDeps {
  db: Kysely<DB>;
  logger: Logger;
  whatsapp: Pick<WhatsAppRuntime, "getCapabilities" | "sendText">;
  settingsRepo: ReturnType<typeof createSettingsRepository>;
}

interface CandidateUser {
  id: string;
  name: string;
  whatsapp_number: string | null;
}

export function decideWhatsAppWindowKeepAlive(
  input: WhatsAppWindowKeepAliveDecisionInput,
): WhatsAppWindowKeepAliveDecision {
  const latestInboundAt = parseTimestamp(input.latestInboundReceivedAt);
  if (!latestInboundAt) return "skip_no_inbound";

  const ageMs = input.now.getTime() - latestInboundAt.getTime();
  if (ageMs < PING_BAND_START_MS) return "skip_recent";
  if (ageMs >= PING_BAND_END_MS) return "skip_lapsed";

  const lastSentAt = parseTimestamp(input.lastKeepAliveSentAt);
  if (lastSentAt && lastSentAt.getTime() >= latestInboundAt.getTime()) return "skip_deduped";

  return "send";
}

export function buildWhatsAppWindowKeepAliveMessage(params: {
  recipientName: string | null | undefined;
  botName: string | null | undefined;
  upcomingTaskCount: number;
}): string {
  const recipientName = formatName(params.recipientName, "there");
  const botName = formatName(params.botName, "Sketch");
  if (params.upcomingTaskCount >= 1) {
    const updateWord = params.upcomingTaskCount === 1 ? "update" : "updates";
    return `Hi ${recipientName}, ${botName} here. I have ${params.upcomingTaskCount} scheduled ${updateWord} coming for you in the next day; WhatsApp closes our chat window after 24 hours of silence, so reply with anything and I'll be able to deliver them to you directly.`;
  }

  return `Hi ${recipientName}, ${botName} here. It's been almost a day since we last talked, so WhatsApp is about to close our chat window; reply with anything to keep it open, otherwise you'll get a short notification template instead of full updates.`;
}

export function startWhatsAppWindowKeepAliveJob(
  deps: WhatsAppWindowKeepAliveJobDeps,
): WhatsAppWindowKeepAliveJobHandle {
  let inFlight = false;

  const runNow = async (): Promise<WhatsAppWindowKeepAliveCounts | null> => {
    if (inFlight) {
      deps.logger.warn("WhatsApp window keep-alive run skipped because a previous run is still active");
      return null;
    }
    inFlight = true;
    try {
      return await runWhatsAppWindowKeepAlive(deps);
    } catch (err) {
      deps.logger.error({ err }, "WhatsApp window keep-alive run failed");
      return null;
    } finally {
      inFlight = false;
    }
  };

  const cron = new Cron(KEEPALIVE_CRON, { timezone: KEEPALIVE_TIMEZONE }, () => {
    runNow().catch((err) => deps.logger.error({ err }, "WhatsApp window keep-alive run failed"));
  });
  deps.logger.info("WhatsApp window keep-alive job scheduled");

  return {
    stop() {
      cron.stop();
      deps.logger.info("WhatsApp window keep-alive job stopped");
    },
    runNow,
  };
}

export async function runWhatsAppWindowKeepAlive(
  deps: WhatsAppWindowKeepAliveJobDeps,
  now = new Date(),
): Promise<WhatsAppWindowKeepAliveCounts> {
  const counts = emptyCounts();

  if (!deps.whatsapp.getCapabilities(CAPABILITY_TARGET).templates) {
    deps.logger.info(counts, "WhatsApp window keep-alive run complete");
    return counts;
  }

  const conversations = createConversationRepository(deps.db);
  const keepAlives = createWhatsAppWindowKeepAliveRepository(deps.db);
  const scheduledTasks = createScheduledTaskRepository(deps.db);
  const settings = await deps.settingsRepo.get();
  const botName = settings?.bot_name ?? "Sketch";
  const candidates = await listCandidateUsers(deps.db);
  counts.candidates = candidates.length;
  const nowIso = now.toISOString();
  const upcomingBefore = new Date(now.getTime() + UPCOMING_TASK_HORIZON_MS).toISOString();

  for (const candidate of candidates) {
    try {
      const latestInbound = await conversations.findLatestInboundWhatsAppDmFromRecipient({
        recipientUserId: candidate.id,
        phoneE164: candidate.whatsapp_number,
      });
      const existing = await keepAlives.get(candidate.id);
      const decision = decideWhatsAppWindowKeepAlive({
        latestInboundReceivedAt: latestInbound?.receivedAt,
        lastKeepAliveSentAt: existing?.sent_at,
        now,
      });

      if (decision !== "send") {
        incrementSkipCount(counts, decision);
        continue;
      }

      const upcomingTaskCount = await scheduledTasks.countActiveForUserWithin(candidate.id, nowIso, upcomingBefore);
      const text = buildWhatsAppWindowKeepAliveMessage({
        recipientName: candidate.name,
        botName,
        upcomingTaskCount,
      });
      const sendFailed = await sendKeepAliveText(deps, candidate, text);
      await keepAlives.recordAttempt(candidate.id, nowIso);
      if (sendFailed) {
        counts.failed += 1;
      } else {
        counts.pinged += 1;
      }
    } catch (err) {
      counts.failed += 1;
      deps.logger.warn({ err, recipientUserId: candidate.id }, "WhatsApp window keep-alive candidate failed");
    }
  }

  deps.logger.info(counts, "WhatsApp window keep-alive run complete");
  return counts;
}

async function sendKeepAliveText(deps: WhatsAppWindowKeepAliveJobDeps, candidate: CandidateUser, text: string) {
  try {
    await deps.whatsapp.sendText({ kind: "dm", phoneE164: candidate.whatsapp_number ?? "" }, text);
    return false;
  } catch (err) {
    deps.logger.warn({ err, recipientUserId: candidate.id }, "WhatsApp window keep-alive send failed");
    return true;
  }
}

async function listCandidateUsers(db: Kysely<DB>): Promise<CandidateUser[]> {
  return db
    .selectFrom("users")
    .select(["id", "name", "whatsapp_number"])
    .where("whatsapp_number", "is not", null)
    .execute();
}

function emptyCounts(): WhatsAppWindowKeepAliveCounts {
  return {
    candidates: 0,
    pinged: 0,
    skipped_recent: 0,
    skipped_lapsed: 0,
    skipped_deduped: 0,
    skipped_no_inbound: 0,
    failed: 0,
  };
}

function incrementSkipCount(
  counts: WhatsAppWindowKeepAliveCounts,
  decision: Exclude<WhatsAppWindowKeepAliveDecision, "send">,
) {
  if (decision === "skip_no_inbound") counts.skipped_no_inbound += 1;
  if (decision === "skip_recent") counts.skipped_recent += 1;
  if (decision === "skip_lapsed") counts.skipped_lapsed += 1;
  if (decision === "skip_deduped") counts.skipped_deduped += 1;
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

function formatName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}
