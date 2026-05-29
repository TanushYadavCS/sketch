import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { SketchMcpDeps, ToolResult } from "./types";

export async function handleUpdateInboxWorkflow(
  params: { inboxMessageId: string; metadata: Record<string, unknown> },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.inboxMessagesRepo || !deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflows are not available in this context." }] };
  }

  const existing = await deps.inboxMessagesRepo.findById(params.inboxMessageId);
  if (!existing || existing.recipient_user_id !== deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow not found." }] };
  }
  if (existing.resolution_mode !== "explicit") {
    return { content: [{ type: "text" as const, text: "Error: inbox item is not an explicit workflow." }] };
  }
  if (existing.resolved_at) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow is already resolved." }] };
  }

  const updated = await deps.inboxMessagesRepo.updateWorkflow(params.inboxMessageId, params.metadata);
  if (!updated) {
    return { content: [{ type: "text" as const, text: "Error: failed to update inbox workflow." }] };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: updated.id,
          status: "updated",
          metadata: updated.metadata ? JSON.parse(updated.metadata) : null,
        }),
      },
    ],
  };
}

export async function handleResolveInboxWorkflow(
  params: { inboxMessageId: string },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.inboxMessagesRepo || !deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflows are not available in this context." }] };
  }

  const existing = await deps.inboxMessagesRepo.findById(params.inboxMessageId);
  if (!existing || existing.recipient_user_id !== deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow not found." }] };
  }
  if (existing.resolution_mode !== "explicit") {
    return { content: [{ type: "text" as const, text: "Error: inbox item is not an explicit workflow." }] };
  }
  if (existing.resolved_at) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow is already resolved." }] };
  }

  const resolved = await deps.inboxMessagesRepo.resolve(params.inboxMessageId);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: params.inboxMessageId,
          status: resolved?.resolved_at ? "resolved" : "not_found",
        }),
      },
    ],
  };
}

export function createInboxWorkflowTools(deps: SketchMcpDeps) {
  return [
    tool(
      "UpdateInboxWorkflow",
      "Update the metadata for one of your explicit inbox workflow items. Use this to save workflow stage, selected recipients, draft text, or reminder state.",
      {
        inboxMessageId: z.string().describe("The inbox workflow ID to update."),
        metadata: z.record(z.string(), z.unknown()).describe("A partial metadata object to merge into the workflow."),
      },
      async (params) => handleUpdateInboxWorkflow(params, deps),
    ),

    tool(
      "ResolveInboxWorkflow",
      "Resolve one of your explicit inbox workflow items so it stops appearing in future inbox context.",
      {
        inboxMessageId: z.string().describe("The inbox workflow ID to resolve."),
      },
      async (params) => handleResolveInboxWorkflow(params, deps),
    ),
  ];
}
