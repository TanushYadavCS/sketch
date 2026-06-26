import type { AgentMasthead } from "../db/repositories/agent-outputs";
import type { AgentApiItem, AgentSectionDef } from "./types";

export type AgentDeliveryRenderPlatform = "slack" | "whatsapp";

export interface RenderableAgentOutput {
  outputDate: string;
  masthead: AgentMasthead | null;
  sections: Record<string, AgentApiItem[]>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatOutputDate(date: string): string {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) return date;
  return `${MONTHS[month - 1] ?? String(month)} ${day}`;
}

function priorityLabel(value: string): string {
  if (value === "high") return "High";
  if (value === "medium") return "Medium";
  if (value === "low") return "Low";
  return value;
}

function slackLink(label: string, url: string | null): string {
  if (!url) return label;
  const safeLabel = label.replaceAll("|", "/").replaceAll("<", "(").replaceAll(">", ")");
  return `<${url}|${safeLabel}>`;
}

function formatItem(item: AgentApiItem, platform: AgentDeliveryRenderPlatform): string {
  const ref = item.displayRef ? ` (${item.displayRef})` : "";
  const title = platform === "slack" ? slackLink(item.title, item.sourceUrl) : item.title;
  const line = `- ${priorityLabel(item.priority)}: ${title}${ref} - ${item.summary}`;
  if (platform === "whatsapp" && item.sourceUrl) return `${line}\n  ${item.sourceUrl}`;
  return line;
}

export function renderAgentOutputForDelivery(params: {
  title: string;
  sections: readonly AgentSectionDef[];
  output: RenderableAgentOutput;
  platform: AgentDeliveryRenderPlatform;
}): string {
  const header = `${params.title} - ${formatOutputDate(params.output.outputDate)}`;
  const lines: string[] = [params.platform === "slack" ? `*${header}*` : header];
  const summary = params.output.masthead?.summary?.trim();
  if (summary) {
    lines.push("", summary);
  }

  for (const section of params.sections) {
    const items = params.output.sections[section.key] ?? [];
    if (items.length === 0) continue;
    lines.push("", params.platform === "slack" ? `*${section.title}*` : section.title);
    for (const item of items) {
      lines.push(formatItem(item, params.platform));
    }
  }

  return lines.join("\n").trim();
}
