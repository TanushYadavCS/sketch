import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { AgentKnowledgeRefs, AgentMasthead, AgentOutputItemInput } from "../../db/repositories/agent-outputs";
import type { ToolResult } from "./types";

const knowledgeRefsSchema = z.object({
  entityIds: z.array(z.string()).default([]),
  fileIds: z.array(z.string()).default([]),
  relationshipIds: z.array(z.string()).default([]),
  mentionIds: z.array(z.string()).default([]),
  sourceRefIds: z.array(z.string()).default([]),
  factIds: z.array(z.string()).default([]),
});

const itemSchema = z.object({
  sectionKey: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  priority: z.enum(["high", "medium", "low"]),
  label: z.string().min(1),
  actionType: z.string().optional(),
  actionLabel: z.string().optional(),
  actionPrompt: z.string().optional(),
  sourceUrl: z.string().optional(),
  knowledgeRefs: knowledgeRefsSchema,
});

export const writeAgentOutputSchema = z.object({
  outputDate: z.string().min(1),
  timezone: z.string().min(1),
  masthead: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    generatedFor: z.string().optional(),
  }),
  items: z.array(itemSchema),
});

export type WriteAgentOutputPayload = z.infer<typeof writeAgentOutputSchema>;

export interface AgentOutputWriter {
  write(payload: {
    outputDate: string;
    timezone: string;
    masthead: AgentMasthead;
    rawPayload: WriteAgentOutputPayload;
    items: AgentOutputItemInput[];
  }): Promise<void>;
}

function normalizeRefs(refs: z.infer<typeof knowledgeRefsSchema>): AgentKnowledgeRefs {
  return {
    entityIds: refs.entityIds,
    fileIds: refs.fileIds,
    relationshipIds: refs.relationshipIds,
    mentionIds: refs.mentionIds,
    sourceRefIds: refs.sourceRefIds,
    factIds: refs.factIds,
  };
}

function mapItems(payload: WriteAgentOutputPayload): AgentOutputItemInput[] {
  const perSectionOrder = new Map<string, number>();
  return payload.items.map((item) => {
    const order = perSectionOrder.get(item.sectionKey) ?? 0;
    perSectionOrder.set(item.sectionKey, order + 1);
    return {
      sectionKey: item.sectionKey,
      title: item.title,
      summary: item.summary,
      priority: item.priority,
      label: item.label,
      actionType: item.actionType ?? "generic",
      actionLabel: item.actionLabel ?? null,
      actionPrompt: item.actionPrompt ?? null,
      sourceUrl: item.sourceUrl ?? null,
      knowledgeRefs: normalizeRefs(item.knowledgeRefs),
      sortOrder: order,
    };
  });
}

/**
 * Generic terminal tool every prebuilt agent calls once to persist its output.
 * Item shape is uniform; per-agent label/section contracts are validated downstream
 * by the agent definition and the run service.
 */
export function createWriteAgentOutputTool(writer: AgentOutputWriter | undefined) {
  return tool(
    "WriteAgentOutput",
    "Validate and save the complete agent output. Call exactly once when the result is ready.",
    writeAgentOutputSchema.shape,
    async (args): Promise<ToolResult> => {
      if (!writer) {
        return { content: [{ type: "text", text: "WriteAgentOutput is not available for this run." }] };
      }
      const payload = writeAgentOutputSchema.parse(args);
      await writer.write({
        outputDate: payload.outputDate,
        timezone: payload.timezone,
        masthead: payload.masthead,
        rawPayload: payload,
        items: mapItems(payload),
      });
      return { content: [{ type: "text", text: "Agent output saved." }] };
    },
  );
}
