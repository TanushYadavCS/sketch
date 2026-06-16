import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type {
  DailyBriefItemInput,
  DailyBriefKnowledgeRefs,
  DailyBriefMasthead,
} from "../../db/repositories/daily-briefs";
import { DAILY_BRIEF_ACTION_LABELS, DAILY_BRIEF_SECTION_LABELS } from "../../db/repositories/daily-briefs";
import type { ToolResult } from "./types";

const knowledgeRefsSchema = z.object({
  entityIds: z.array(z.string()).default([]),
  fileIds: z.array(z.string()).default([]),
  relationshipIds: z.array(z.string()).default([]),
  mentionIds: z.array(z.string()).default([]),
  sourceRefIds: z.array(z.string()).default([]),
  factIds: z.array(z.string()).default([]),
});

const baseBriefItemSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  priority: z.enum(["high", "medium", "low"]),
  actionType: z.string().optional(),
  actionLabel: z.string().optional(),
  actionPrompt: z.string().optional(),
  sourceUrl: z.string().optional(),
  knowledgeRefs: knowledgeRefsSchema,
});

const todoItemSchema = baseBriefItemSchema.extend({
  label: z.enum(DAILY_BRIEF_SECTION_LABELS.todos),
  actionLabel: z.enum(DAILY_BRIEF_ACTION_LABELS.todos).optional(),
});

const customerUpdateItemSchema = baseBriefItemSchema.extend({
  label: z.enum(DAILY_BRIEF_SECTION_LABELS.customer_updates),
  actionLabel: z.enum(DAILY_BRIEF_ACTION_LABELS.customer_updates).optional(),
});

const activeProjectItemSchema = baseBriefItemSchema.extend({
  label: z.enum(DAILY_BRIEF_SECTION_LABELS.active_projects),
  actionLabel: z.enum(DAILY_BRIEF_ACTION_LABELS.active_projects).optional(),
});

export const writeDailyBriefSchema = z.object({
  briefDate: z.string().min(1),
  timezone: z.string().min(1),
  masthead: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    generatedFor: z.string().optional(),
  }),
  todos: z.array(todoItemSchema),
  customerUpdates: z.array(customerUpdateItemSchema),
  activeProjects: z.array(activeProjectItemSchema),
});

export type WriteDailyBriefPayload = z.infer<typeof writeDailyBriefSchema>;

export interface DailyBriefWriter {
  write(payload: {
    briefDate: string;
    timezone: string;
    masthead: DailyBriefMasthead;
    rawPayload: WriteDailyBriefPayload;
    items: DailyBriefItemInput[];
  }): Promise<void>;
}

function normalizeRefs(refs: z.infer<typeof knowledgeRefsSchema>): DailyBriefKnowledgeRefs {
  return {
    entityIds: refs.entityIds,
    fileIds: refs.fileIds,
    relationshipIds: refs.relationshipIds,
    mentionIds: refs.mentionIds,
    sourceRefIds: refs.sourceRefIds,
    factIds: refs.factIds,
  };
}

function mapItems(
  sectionKey: DailyBriefItemInput["sectionKey"],
  items: Array<
    z.infer<typeof todoItemSchema> | z.infer<typeof customerUpdateItemSchema> | z.infer<typeof activeProjectItemSchema>
  >,
): DailyBriefItemInput[] {
  return items.map((item, index) => ({
    sectionKey,
    title: item.title,
    summary: item.summary,
    priority: item.priority,
    label: item.label,
    actionType: item.actionType ?? "generic",
    actionLabel: item.actionLabel ?? null,
    actionPrompt: item.actionPrompt ?? null,
    sourceUrl: item.sourceUrl ?? null,
    knowledgeRefs: normalizeRefs(item.knowledgeRefs),
    sortOrder: index,
  }));
}

export function createWriteDailyBriefTool(writer: DailyBriefWriter | undefined) {
  return tool(
    "WriteDailyBrief",
    "Validate and save the complete fixed-section Daily Brief. Call exactly once when the brief is ready.",
    writeDailyBriefSchema.shape,
    async (args): Promise<ToolResult> => {
      if (!writer) {
        return { content: [{ type: "text", text: "WriteDailyBrief is not available for this run." }] };
      }
      const payload = writeDailyBriefSchema.parse(args);
      const items = [
        ...mapItems("todos", payload.todos),
        ...mapItems("customer_updates", payload.customerUpdates),
        ...mapItems("active_projects", payload.activeProjects),
      ];
      await writer.write({
        briefDate: payload.briefDate,
        timezone: payload.timezone,
        masthead: payload.masthead,
        rawPayload: payload,
        items,
      });
      return { content: [{ type: "text", text: "Daily Brief saved." }] };
    },
  );
}
