/**
 * Steal-confirmation delivery for automation edit locks (automation-sharing).
 *
 * Owned by the channel-delivery lane: everything needed to (a) notify the
 * lock holder on their surface when a steal request is recorded and (b)
 * process the holder's approve/deny response from Slack buttons or WhatsApp
 * text codes, replying to the requester on their surface via the
 * steal_requester_* fields.
 *
 * Web-builder holders get no server-side delivery — the builder's polling
 * (web UI) handles their approval — so "web" is deliberately a no-op here.
 * Undeliverable notifications (missing conversation id, unknown platform,
 * send failures) are logged with taskId/userId only, never message content,
 * and expired steals are left for steal_expires_at lazy expiry.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { approveSteal, denySteal } from "../automation/lock-service";
import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { type WhatsAppTarget, whatsappTargetFromDeliveryTarget } from "./provider";

export type WhatsAppStealCommand =
  | { kind: "confirm"; taskId: string }
  | { kind: "deny"; taskId: string }
  | { kind: "unrecognized" };

export type StealResponseOutcome =
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "not_found" }
  | { kind: "not_holder" }
  | { kind: "no_pending_steal" };

/**
 * Outbound delivery closures the adapters inject. Keeping them structural
 * keeps this module free of SlackBot/WhatsAppRuntime imports while letting
 * both adapters share one delivery path.
 */
export interface StealNotificationSenders {
  slack?: {
    postLockStealRequest: (params: {
      channelId: string;
      taskId: string;
      requesterName: string;
      taskTitle: string;
    }) => Promise<unknown>;
    sendText: (channelId: string, text: string) => Promise<unknown>;
  };
  whatsapp?: {
    sendText: (target: WhatsAppTarget, text: string) => Promise<unknown>;
  };
}

/** WhatsApp text codes: `CONFIRM-STEAL <taskId>` / `DENY-STEAL <taskId>`. */
export function parseWhatsAppStealCommand(text: string): WhatsAppStealCommand {
  const confirm = /^\s*confirm-steal\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/iu.exec(text);
  if (confirm) return { kind: "confirm", taskId: confirm[1] };
  const deny = /^\s*deny-steal\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/iu.exec(text);
  if (deny) return { kind: "deny", taskId: deny[1] };
  return { kind: "unrecognized" };
}

/** Holder-facing WhatsApp notification for a recorded steal request. */
export function renderWhatsAppStealRequest(params: {
  requesterName: string;
  taskTitle: string;
  taskId: string;
}): string {
  return `${params.requesterName} wants to take over editing "${params.taskTitle}". Reply CONFIRM-STEAL ${params.taskId} to approve or DENY-STEAL ${params.taskId} to deny.`;
}

/** Requester-facing outcome message, shared by Slack and WhatsApp. */
export function renderStealOutcomeText(params: {
  responderName: string;
  taskTitle: string;
  approved: boolean;
}): string {
  return params.approved
    ? `${params.responderName} approved your request to take over editing "${params.taskTitle}". You can now edit it.`
    : `${params.responderName} denied your request to take over editing "${params.taskTitle}".`;
}

/** Responder-facing confirmation for their approve/deny attempt. */
export function renderStealResponseConfirmation(outcome: StealResponseOutcome): string {
  switch (outcome.kind) {
    case "approved":
      return "Steal request approved — the requester can now edit this automation.";
    case "denied":
      return "Steal request denied.";
    case "not_found":
      return "That automation no longer exists.";
    case "not_holder":
      return "Only the current editor can respond to a take-over request.";
    case "no_pending_steal":
      return "There is no pending take-over request for this automation.";
  }
}

/**
 * Deliver a recorded steal request to the holder's surface using the lock
 * row's holder_platform / holder_surface / holder_conversation_id. Web
 * holders are skipped (builder polling owns approval). Callers invoke this
 * right after requestSteal returns pending; delivery failures are logged and
 * never re-raised — the steal still lapses via steal_expires_at.
 */
export async function notifyStealRequested(params: {
  db: Kysely<DB>;
  logger: Logger;
  taskId: string;
  senders: StealNotificationSenders;
}): Promise<void> {
  const { db, logger, taskId, senders } = params;
  const locks = createAutomationLocksRepository(db);
  const row = await locks.getByTaskId(taskId);
  if (!row || row.steal_requester_user_id === null) return;
  if (row.steal_expires_at === null || row.steal_expires_at <= new Date().toISOString()) return;

  const [requester, task] = await Promise.all([
    createUserRepository(db).findById(row.steal_requester_user_id),
    createScheduledTaskRepository(db).getById(taskId),
  ]);
  const requesterName = requester?.name ?? row.steal_requester_user_id;
  const taskTitle = task?.title ?? taskId;

  if (row.holder_platform === "slack") {
    if (!senders.slack || !row.holder_conversation_id) {
      logger.warn({ taskId, holderUserId: row.holder_user_id }, "Cannot deliver steal request to Slack holder");
      return;
    }
    try {
      await senders.slack.postLockStealRequest({
        channelId: row.holder_conversation_id,
        taskId,
        requesterName,
        taskTitle,
      });
    } catch (err) {
      logger.warn({ err, taskId, holderUserId: row.holder_user_id }, "Slack steal request delivery failed");
    }
    return;
  }

  if (row.holder_platform === "whatsapp") {
    if (!senders.whatsapp || !row.holder_conversation_id) {
      logger.warn({ taskId, holderUserId: row.holder_user_id }, "Cannot deliver steal request to WhatsApp holder");
      return;
    }
    try {
      await senders.whatsapp.sendText(
        whatsappTargetFromDeliveryTarget(row.holder_conversation_id),
        renderWhatsAppStealRequest({ requesterName, taskTitle, taskId }),
      );
    } catch (err) {
      logger.warn({ err, taskId, holderUserId: row.holder_user_id }, "WhatsApp steal request delivery failed");
    }
    return;
  }

  if (row.holder_platform !== "web") {
    logger.warn(
      { taskId, holderUserId: row.holder_user_id, holderPlatform: row.holder_platform },
      "Unknown holder platform for steal request delivery",
    );
  }
}

/**
 * Shared approve/deny response flow for Slack buttons and WhatsApp text
 * codes. Captures the steal_requester_* fields before the state machine
 * transition (approve/deny clear them), calls lock-service, then delivers the
 * outcome to the requester's surface. Returns the lock-service outcome kind
 * so callers can render a responder-facing confirmation.
 */
export async function handleStealResponse(params: {
  db: Kysely<DB>;
  logger: Logger;
  taskId: string;
  responderUserId: string;
  responderName: string;
  approve: boolean;
  senders: StealNotificationSenders;
}): Promise<StealResponseOutcome> {
  const { db, logger, taskId, responderUserId, responderName, approve, senders } = params;
  const locks = createAutomationLocksRepository(db);
  const row = await locks.getByTaskId(taskId);
  if (!row) return { kind: "not_found" };

  const requesterUserId = row.steal_requester_user_id;
  const requesterPlatform = row.steal_requester_platform;
  const requesterConversationId = row.steal_requester_conversation_id;

  const responded = approve
    ? await approveSteal(db, { taskId, approverUserId: responderUserId })
    : await denySteal(db, { taskId, holderUserId: responderUserId });
  if (responded.kind !== "approved" && responded.kind !== "denied") return { kind: responded.kind };

  const task = await createScheduledTaskRepository(db).getById(taskId);
  const taskTitle = task?.title ?? taskId;
  const outcomeText = renderStealOutcomeText({ responderName, taskTitle, approved: approve });

  if (requesterPlatform === "slack" && requesterConversationId) {
    if (!senders.slack) {
      logger.warn({ taskId, requesterUserId }, "Cannot deliver steal outcome to Slack requester");
      return { kind: responded.kind };
    }
    try {
      await senders.slack.sendText(requesterConversationId, outcomeText);
    } catch (err) {
      logger.warn({ err, taskId, requesterUserId }, "Slack steal outcome delivery failed");
    }
    return { kind: responded.kind };
  }

  if (requesterPlatform === "whatsapp" && requesterConversationId) {
    if (!senders.whatsapp) {
      logger.warn({ taskId, requesterUserId }, "Cannot deliver steal outcome to WhatsApp requester");
      return { kind: responded.kind };
    }
    try {
      await senders.whatsapp.sendText(whatsappTargetFromDeliveryTarget(requesterConversationId), outcomeText);
    } catch (err) {
      logger.warn({ err, taskId, requesterUserId }, "WhatsApp steal outcome delivery failed");
    }
    return { kind: responded.kind };
  }

  if (requesterPlatform && requesterPlatform !== "web" && requesterUserId) {
    logger.warn({ taskId, requesterUserId }, "Cannot deliver steal outcome to requester");
  }
  return { kind: responded.kind };
}
