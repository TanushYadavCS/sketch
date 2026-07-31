import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { ChatHistoryAccessResolver, type ProviderTargetRef, providerTargetKey } from "./chat-search";
import type { SelectableUser, SketchMcpDeps, ToolResult } from "./types";

function detectPlatform(recipient: SelectableUser): "slack" | "whatsapp" | null {
  if (recipient.slack_user_id) return "slack";
  if (recipient.whatsapp_number) return "whatsapp";
  return null;
}

function formatUserMatch(user: SelectableUser, matchedBy: string) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    slackUserId: user.slack_user_id,
    channels: [...(user.slack_user_id ? ["slack"] : []), ...(user.whatsapp_number ? ["whatsapp"] : [])],
    matchedBy,
  };
}

function extractSlackUserId(query: string): string | null {
  const mentionMatch = query.trim().match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return mentionMatch[1];
  const rawSlackIdMatch = query.trim().match(/^[A-Z][A-Z0-9]{4,}$/i);
  return rawSlackIdMatch ? rawSlackIdMatch[0] : null;
}

function looksLikeEmail(query: string): boolean {
  return query.includes("@");
}

async function deliverMessageToUser(
  params: { recipientUserId: string; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<
  | { status: "sent"; recipient: SelectableUser; platform: "slack" | "whatsapp"; inboxMessageId?: string }
  | { status: "skipped" | "failed"; error: string; recipient?: SelectableUser }
> {
  if (!deps.userRepo || !deps.sendDm || !deps.currentUserId) {
    return { status: "failed", error: "messaging is not available in this context." };
  }
  if (params.recipientUserId === deps.currentUserId) {
    return { status: "failed", error: "cannot send a message to yourself." };
  }

  const recipient = await deps.userRepo.findById(params.recipientUserId);
  if (!recipient) return { status: "failed", error: "user not found." };

  const platform = detectPlatform(recipient);
  if (!platform) {
    return { status: "failed", error: `${recipient.name} has no connected channel (Slack or WhatsApp).`, recipient };
  }

  const delivery = await deps.sendDm({
    userId: params.recipientUserId,
    platform,
    message: params.message,
    ...(platform === "whatsapp"
      ? {
          senderUserId: deps.currentUserId,
          storeInInbox: params.storeInInbox !== false,
          inboxKind: "note",
        }
      : {}),
  });
  const { channelId, messageRef } = delivery;

  let inboxMessageId: string | undefined = delivery.inboxMessageId;
  if (params.storeInInbox !== false && !inboxMessageId) {
    if (!deps.inboxMessagesRepo) {
      return { status: "failed", error: "Inbox storage is not available in this context.", recipient };
    }
    const inboxMessage = await deps.inboxMessagesRepo.create({
      senderUserId: deps.currentUserId,
      recipientUserId: params.recipientUserId,
      message: params.message,
      platform,
      channelId,
      messageRef,
    });
    inboxMessageId = inboxMessage.id;
  }

  return { status: "sent", recipient, platform, inboxMessageId };
}

export interface SendMessageTarget {
  platform: "slack" | "whatsapp";
  targetType: "channel" | "group";
  targetId: string;
}

export interface SendMessageParams {
  message: string;
  recipientUserId?: string;
  target?: SendMessageTarget;
  threadTs?: string;
}

export type SendMessageDeps = Pick<
  SketchMcpDeps,
  "inboxMessagesRepo" | "userRepo" | "sendDm" | "sendTargetMessage" | "currentUserId" | "db" | "conversationContext"
>;

/** Structural slice of ChatHistoryAccessResolver so callers can inject a stub. */
export interface SendMessageTargetAccess {
  authorizedProviderTargets: (targets: ProviderTargetRef[]) => Promise<Set<string>>;
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

const THREAD_TS_SCOPE_ERROR = "threadTs can only be used with a Slack channel target.";

function validateTarget(target: SendMessageTarget, threadTs: string | undefined): string | null {
  if (!target.targetId.trim()) {
    return "target.targetId is required. Use SearchDeliveryTargets to find the channel or group first.";
  }
  if (target.platform === "slack" && target.targetType !== "channel") {
    return "A Slack target must use targetType 'channel'.";
  }
  if (target.platform === "whatsapp" && target.targetType !== "group") {
    return "A WhatsApp target must use targetType 'group'.";
  }
  if (threadTs !== undefined) {
    if (!threadTs.trim()) return "threadTs must not be empty. Omit it to post a top-level message.";
    if (target.platform !== "slack") return THREAD_TS_SCOPE_ERROR;
  }
  return null;
}

/**
 * Posting into a shared destination is allowed only when the person who asked
 * is a member of it, checked before the send so a denial never leaks content.
 * Membership comes from the same passive rosters chat history uses, so a very
 * recent join may not be visible yet.
 */
async function sendToTarget(
  params: SendMessageParams & { target: SendMessageTarget },
  deps: SendMessageDeps,
  access: SendMessageTargetAccess,
): Promise<ToolResult> {
  const { target, threadTs } = params;
  const invalid = validateTarget(target, threadTs);
  if (invalid) return toolError(invalid);

  if (!deps.sendTargetMessage) {
    return toolError("Sending to a channel or group is not available in this context.");
  }
  if (!deps.db || !deps.currentUserId) {
    return toolError("Sending to a channel or group requires an authenticated requesting user.");
  }

  const authorized = await access.authorizedProviderTargets([{ platform: target.platform, targetId: target.targetId }]);
  if (!authorized.has(providerTargetKey({ platform: target.platform, targetId: target.targetId }))) {
    return toolError(
      "the person you are working for is not a known member of that channel or group, so Sketch will not post there. Ask them to confirm the target with SearchDeliveryTargets. If they joined very recently, it can take a short while before the membership is seen.",
    );
  }

  try {
    const { messageRef } = await deps.sendTargetMessage({
      platform: target.platform,
      targetType: target.targetType,
      targetId: target.targetId,
      message: params.message,
      ...(threadTs ? { threadTs } : {}),
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "sent",
            platform: target.platform,
            targetType: target.targetType,
            targetId: target.targetId,
            ...(threadTs ? { threadTs } : {}),
            ...(messageRef ? { messageRef } : {}),
          }),
        },
      ],
    };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Unknown error");
  }
}

export async function handleSendMessage(
  params: SendMessageParams,
  deps: SendMessageDeps,
  access: SendMessageTargetAccess = new ChatHistoryAccessResolver(deps),
): Promise<ToolResult> {
  if (params.recipientUserId !== undefined && params.target !== undefined) {
    return toolError("set only one of recipientUserId or target, not both.");
  }
  if (params.target !== undefined) {
    return sendToTarget({ ...params, target: params.target }, deps, access);
  }
  if (params.recipientUserId === undefined) {
    return toolError("set exactly one of recipientUserId (for a direct message) or target (for a channel or group).");
  }
  if (!params.recipientUserId.trim()) {
    return toolError("recipientUserId must not be empty. Use GetTeamDirectory or SearchUsers to find the user ID.");
  }
  if (params.threadTs !== undefined) return toolError(THREAD_TS_SCOPE_ERROR);

  const result = await deliverMessageToUser(
    { recipientUserId: params.recipientUserId, message: params.message, storeInInbox: true },
    deps,
  );
  if (result.status !== "sent") {
    return toolError(result.error);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: result.inboxMessageId,
          recipientName: result.recipient.name,
          status: "sent",
        }),
      },
    ],
  };
}

export const searchUsersToolSchema = {
  queries: z.array(z.string()).describe("Names, emails, Slack mentions, or Slack user IDs to resolve."),
};

export type SearchUsersArgs = { queries: string[] };

export async function handleSearchUsers(
  params: SearchUsersArgs,
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.userRepo) {
    return { content: [{ type: "text" as const, text: "User search is not available in this context." }] };
  }

  const results: Array<{ query: string; matches: Array<Record<string, unknown>> }> = [];

  for (const query of params.queries) {
    const matches: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const slackUserId = extractSlackUserId(query);
    const trimmedQuery = query.trim();

    const pushMatch = (user: SelectableUser | undefined, matchedBy: string) => {
      if (!user || user.id === deps.currentUserId || seen.has(user.id)) return;
      seen.add(user.id);
      matches.push(formatUserMatch(user, matchedBy));
    };

    if (slackUserId) {
      pushMatch(await deps.userRepo.findBySlackId?.(slackUserId), "slack_user_id");
    }

    if (looksLikeEmail(trimmedQuery)) {
      pushMatch(await deps.userRepo.findByEmail?.(trimmedQuery), "exact_email");
    }

    pushMatch(await deps.userRepo.findByExactName?.(trimmedQuery, deps.currentUserId), "exact_name");

    const prefixMatches = deps.userRepo.searchByNamePrefix
      ? await deps.userRepo.searchByNamePrefix(trimmedQuery, 5, deps.currentUserId)
      : [];
    for (const user of prefixMatches) {
      pushMatch(user, "prefix_name");
    }

    if (trimmedQuery.length >= 3) {
      const substringMatches = deps.userRepo.searchByNameSubstring
        ? await deps.userRepo.searchByNameSubstring(trimmedQuery, 5, deps.currentUserId)
        : [];
      for (const user of substringMatches) {
        pushMatch(user, "substring_name");
      }
    }

    results.push({ query, matches });
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export async function handleSendMessageToUsers(
  params: { recipientUserIds: string[]; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<ToolResult> {
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const recipientUserId of params.recipientUserIds) {
    if (seen.has(recipientUserId)) {
      results.push({ recipientUserId, status: "skipped", error: "Duplicate recipient in request" });
      continue;
    }
    seen.add(recipientUserId);

    try {
      const result = await deliverMessageToUser(
        { recipientUserId, message: params.message, storeInInbox: params.storeInInbox },
        deps,
      );

      if (result.status === "sent") {
        results.push({
          recipientUserId,
          recipientName: result.recipient.name,
          status: "sent",
          platform: result.platform,
          ...(result.inboxMessageId ? { inboxMessageId: result.inboxMessageId } : {}),
        });
      } else {
        results.push({
          recipientUserId,
          recipientName: result.recipient?.name,
          status: result.status,
          error: result.error,
        });
      }
    } catch (error) {
      results.push({
        recipientUserId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export function createMessagingTools(deps: SketchMcpDeps) {
  return [
    tool(
      "SearchUsers",
      "Resolve names, emails, Slack mentions, and Slack user IDs into tenant users. Returns ranked candidates so you can confirm recipients before sending messages.",
      searchUsersToolSchema,
      async (params) => handleSearchUsers(params, deps),
    ),

    tool(
      "SendMessage",
      "Send one message, either as a DM to a team member or into a Slack channel or WhatsApp group. Set exactly one of recipientUserId or target. A DM goes out on the person's connected channel and the same text is also stored as a one-way inbox item, so their agent can see it on their next private chat. For a channel or group, first resolve it with SearchDeliveryTargets and pass the platform, targetType, and targetId it returns; the person you are working for must be a member of it.",
      {
        message: z.string().describe("The exact message text to send."),
        recipientUserId: z.string().optional().describe("The user ID from GetTeamDirectory. Use this to send a DM."),
        target: z
          .object({
            platform: z.enum(["slack", "whatsapp"]).describe("The platform the target belongs to."),
            targetType: z
              .enum(["channel", "group"])
              .describe("Use 'channel' for Slack and 'group' for WhatsApp. Other combinations are rejected."),
            targetId: z
              .string()
              .describe("The targetId returned by SearchDeliveryTargets. Never guess a channel ID or group JID."),
          })
          .optional()
          .describe("The channel or group to post in, exactly as returned by SearchDeliveryTargets."),
        threadTs: z
          .string()
          .optional()
          .describe("Slack thread timestamp to reply in. Only valid with a Slack channel target."),
      },
      async (params) => handleSendMessage(params, deps),
    ),

    tool(
      "SendMessageToUsers",
      "Send the same DM to multiple team members. When storeInInbox is true, the sent message is also stored as a one-way inbox item for each successful recipient.",
      {
        recipientUserIds: z.array(z.string()).describe("The recipient user IDs to message."),
        message: z.string().describe("The exact message text to send to every recipient."),
        storeInInbox: z
          .boolean()
          .optional()
          .describe(
            "Whether to store the sent message in each recipient's inbox. Defaults to true. WhatsApp out-of-window content is always parked in the inbox regardless of this setting so it is not lost.",
          ),
      },
      async (params) => handleSendMessageToUsers(params, deps),
    ),
  ];
}
