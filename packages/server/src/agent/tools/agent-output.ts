import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { AgentKnowledgeRefs, AgentMasthead, AgentOutputItemInput } from "../../db/repositories/agent-outputs";
import type { ToolResult } from "./types";

export const MAX_AGENT_OUTPUT_PAYLOAD_BYTES = 256 * 1024;
export const WRITE_AGENT_OUTPUT_TOOL_NAME = "WriteAgentOutput";

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
  /**
   * Free-form section-specific structured data. The shape is documented per
   * section in the agent instructions; each definition normalizes it downstream.
   */
  structuredPayload: z.record(z.string(), z.unknown()).optional(),
  knowledgeRefs: knowledgeRefsSchema,
});

export const writeAgentOutputSchema = z
  .object({
    outputDate: z.string().min(1),
    timezone: z.string().min(1),
    masthead: z.object({
      title: z.string().min(1),
      summary: z.string().min(1),
      generatedFor: z.string().optional(),
    }),
    items: z.array(itemSchema),
  })
  .superRefine((payload, ctx) => {
    if (serializedPayloadBytes(payload) <= MAX_AGENT_OUTPUT_PAYLOAD_BYTES) return;
    ctx.addIssue({
      code: "custom",
      message: `Agent output payload exceeds ${MAX_AGENT_OUTPUT_PAYLOAD_BYTES} bytes.`,
    });
  });

export type WriteAgentOutputPayload = z.infer<typeof writeAgentOutputSchema>;

export interface AgentOutputWriter {
  recordRejectedAttempt?(error: unknown): void;
  write(payload: {
    outputDate: string;
    timezone: string;
    masthead: AgentMasthead;
    rawPayload: WriteAgentOutputPayload;
    items: AgentOutputItemInput[];
  }): Promise<void>;
}

export function recordRejectedWriteAgentOutputCall(
  writer: AgentOutputWriter | undefined,
  toolName: string,
  input: unknown,
): void {
  if (
    !writer?.recordRejectedAttempt ||
    (toolName !== WRITE_AGENT_OUTPUT_TOOL_NAME && !toolName.endsWith(`__${WRITE_AGENT_OUTPUT_TOOL_NAME}`))
  ) {
    return;
  }
  const result = writeAgentOutputSchema.safeParse(input);
  if (!result.success) writer.recordRejectedAttempt(result.error);
}

export function assertAgentOutputPayloadSize(payload: unknown): void {
  if (serializedPayloadBytes(payload) <= MAX_AGENT_OUTPUT_PAYLOAD_BYTES) return;
  throw new Error(`Agent output payload exceeds ${MAX_AGENT_OUTPUT_PAYLOAD_BYTES} bytes.`);
}

function serializedPayloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? "null", "utf8");
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
      structuredPayload: item.structuredPayload ?? null,
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
    WRITE_AGENT_OUTPUT_TOOL_NAME,
    "Validate and save the complete agent output. Call exactly once when the result is ready.",
    writeAgentOutputSchema.shape,
    async (args): Promise<ToolResult> => {
      if (!writer) {
        return { content: [{ type: "text", text: "WriteAgentOutput is not available for this run." }] };
      }
      let payload: WriteAgentOutputPayload;
      try {
        payload = writeAgentOutputSchema.parse(args);
      } catch (error) {
        writer.recordRejectedAttempt?.(error);
        throw error;
      }
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
