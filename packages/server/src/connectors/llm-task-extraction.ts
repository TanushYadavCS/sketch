import type { GeminiGenerator } from "./gemini-generate";
import type { LlmTaskCandidate } from "./types";

export const LLM_TASK_PROMPT_VERSION = "llm-task-v1";

export interface ExtractLlmTaskCandidatesInput {
  content: string;
  sourceDate?: string;
  attendees?: Array<{ name?: string; email?: string }>;
  parentRefs?: Array<{ source: string; sourceId: string }>;
  priorTitles?: string[];
  generator: GeminiGenerator;
  promptVersion?: string;
  dumpDir?: string;
}

export async function extractLlmTaskCandidates(input: ExtractLlmTaskCandidatesInput): Promise<LlmTaskCandidate[]> {
  const promptVersion = input.promptVersion ?? LLM_TASK_PROMPT_VERSION;
  const attendees =
    input.attendees && input.attendees.length > 0
      ? input.attendees.map((a) => `- ${a.name ?? "Unknown"}${a.email ? ` <${a.email}>` : ""}`).join("\n")
      : "None provided";
  const parentRefs =
    input.parentRefs && input.parentRefs.length > 0
      ? input.parentRefs.map((p) => `- ${p.source}:${p.sourceId}`).join("\n")
      : "None provided";
  const priorTitleSection =
    input.priorTitles && input.priorTitles.length > 0
      ? `
Previously extracted action-items from this source:
${input.priorTitles.map((title) => `- ${title}`).join("\n")}
Rules:
- If an action below still applies, REUSE ITS EXACT TITLE verbatim — do not rephrase.
- Only create a new action-item for something genuinely not covered above.
- Omit an action only if the source no longer supports it.
`
      : "";
  const sourceDateLine = input.sourceDate ? `\nSource date: ${input.sourceDate}\n` : "";
  const prompt = `You extract concrete action-items from meeting, email, or chat content.

Prompt version: ${promptVersion}
${sourceDateLine}

Return only JSON:
{
  "tasks": [
    {
      "title": "Ship Slack capture",
      "owner": { "name": "Jane Doe", "email": "jane@example.com" },
      "dueDate": "2025-04-30",
      "hasOwnerVerbObject": true,
      "sourceExcerpt": "Jane will ship Slack capture by Friday."
    }
  ]
}

Rules:
- Emit only action-items that someone could complete.
- The title must be short, imperative or outcome-oriented, and include the action object.
- Set hasOwnerVerbObject to true only when the content names an owner, a concrete verb, and an object.
- Drop vague chatter, ideas, agenda items, and "circle back" phrasing unless an owner and concrete action are present.
- Owner is optional. Include name or email only when explicitly supported.
- dueDate: ISO date (YYYY-MM-DD) the action is due, resolved against the source date below; null if no due date is stated. Do not invent one.
- sourceExcerpt should be a brief supporting quote from the source.
- If no action-items are present, return { "tasks": [] }.

Attendees:
${attendees}

Parent refs:
${parentRefs}
${priorTitleSection}

Content:
<content>
${input.content.slice(0, 24000)}
</content>`;

  const parsed = await input.generator.generateJSON<{ tasks: unknown[] }>(prompt, {
    maxTokens: 8192,
    label: "extractLlmTask",
    dumpDir: input.dumpDir,
  });
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  return tasks.flatMap(readCandidate);
}

function readCandidate(value: unknown): LlmTaskCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || record.title.trim().length === 0) return [];
  if (typeof record.hasOwnerVerbObject !== "boolean") return [];
  const owner = readOwner(record.owner);
  const dueDate =
    typeof record.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.dueDate) ? record.dueDate : undefined;
  return [
    {
      title: record.title.trim(),
      owner,
      dueDate,
      hasOwnerVerbObject: record.hasOwnerVerbObject,
      sourceExcerpt: typeof record.sourceExcerpt === "string" ? record.sourceExcerpt.trim() : undefined,
    },
  ];
}

function readOwner(value: unknown): { name?: string; email?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
  const email = typeof record.email === "string" && record.email.trim() ? record.email.trim() : undefined;
  return name || email ? { name, email } : undefined;
}
