import type { LlmCallFn } from "./llm";
import { createLlmCallFn } from "./llm";
import type { LlmTaskCandidate } from "./types";

export const LLM_TASK_PROMPT_VERSION = "llm-task-v1";

export interface ExtractLlmTaskCandidatesInput {
  content: string;
  attendees?: Array<{ name?: string; email?: string }>;
  parentRefs?: Array<{ source: string; sourceId: string }>;
  llmCall?: LlmCallFn;
  promptVersion?: string;
}

export async function extractLlmTaskCandidates(input: ExtractLlmTaskCandidatesInput): Promise<LlmTaskCandidate[]> {
  const llmCall = input.llmCall ?? createLlmCallFn();
  const promptVersion = input.promptVersion ?? LLM_TASK_PROMPT_VERSION;
  const attendees =
    input.attendees && input.attendees.length > 0
      ? input.attendees.map((a) => `- ${a.name ?? "Unknown"}${a.email ? ` <${a.email}>` : ""}`).join("\n")
      : "None provided";
  const parentRefs =
    input.parentRefs && input.parentRefs.length > 0
      ? input.parentRefs.map((p) => `- ${p.source}:${p.sourceId}`).join("\n")
      : "None provided";
  const prompt = `You extract concrete action-items from meeting, email, or chat content.

Prompt version: ${promptVersion}

Return only JSON:
{
  "tasks": [
    {
      "title": "Ship Slack capture",
      "owner": { "name": "Jane Doe", "email": "jane@example.com" },
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
- sourceExcerpt should be a brief supporting quote from the source.
- If no action-items are present, return { "tasks": [] }.

Attendees:
${attendees}

Parent refs:
${parentRefs}

Content:
<content>
${input.content.slice(0, 24000)}
</content>`;

  const result = await llmCall(prompt, { maxTokens: 2048 });
  const parsed = parseJsonObject(result.text);
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  return tasks.flatMap(readCandidate);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(body ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readCandidate(value: unknown): LlmTaskCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || record.title.trim().length === 0) return [];
  if (typeof record.hasOwnerVerbObject !== "boolean") return [];
  const owner = readOwner(record.owner);
  return [
    {
      title: record.title.trim(),
      owner,
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
