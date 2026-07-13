import type { AgentDeliveryMention, AgentMasthead } from "../db/repositories/agent-outputs";
import type { AgentApiItem, AgentSectionDef } from "./types";

export type AgentDeliveryRenderPlatform = "slack" | "whatsapp";

export interface RenderableAgentOutput {
  outputDate: string;
  masthead: AgentMasthead | null;
  sections: Record<string, AgentApiItem[]>;
  sourceLabel?: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MASTHEAD_SUMMARY_LIMIT = 420;
const ITEM_TITLE_LIMIT = 96;
const ITEM_SUMMARY_LIMIT = 260;

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

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, limit: number): string {
  const compact = compactWhitespace(value);
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function slackLink(label: string, url: string | null): string {
  if (!url) return label;
  const safeLabel = label.replaceAll("|", "/").replaceAll("<", "(").replaceAll(">", ")");
  return `<${url}|${safeLabel}>`;
}

function sanitizeSlackText(value: string): string {
  return value
    .replaceAll("*", "")
    .replaceAll("_", "")
    .replaceAll("`", "")
    .replaceAll("|", "/")
    .replaceAll("<", "(")
    .replaceAll(">", ")");
}

/** Strips WhatsApp emphasis markers from a segment we are about to wrap in bold/italic, so stray markup can't break formatting. */
function sanitizeWhatsAppInline(value: string): string {
  return value.replaceAll("*", "").replaceAll("_", "").replaceAll("~", "").replaceAll("`", "");
}

function isSlackMentionTargetId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

function formatMention(mention: AgentDeliveryMention, platform: AgentDeliveryRenderPlatform): string | null {
  if (mention.platform !== platform) return null;
  if (platform === "slack") return isSlackMentionTargetId(mention.targetId) ? `<@${mention.targetId}>` : null;
  const label = mention.label?.trim() || mention.targetId;
  const withoutPhonePrefix = label.replace(/^dm:/, "");
  const display = withoutPhonePrefix
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "")
    .replace(/\s+/g, "");
  return display ? `@${display}` : null;
}

function formatItem(item: AgentApiItem, platform: AgentDeliveryRenderPlatform, runSourceLabel?: string | null): string {
  const titleText = clip(item.title, ITEM_TITLE_LIMIT);
  const title =
    platform === "slack" ? slackLink(sanitizeSlackText(titleText), item.sourceUrl) : sanitizeWhatsAppInline(titleText);
  const summaryText = clip(item.summary, ITEM_SUMMARY_LIMIT);
  const summary = platform === "slack" ? sanitizeSlackText(summaryText) : summaryText;
  const headline = `- *${title}* - ${summary}`;
  const perItemSource = item.displayRef && item.displayRef !== runSourceLabel ? item.displayRef : null;
  const metadata = [item.priority === "high" ? `${priorityLabel(item.priority)} priority` : null, perItemSource]
    .filter(Boolean)
    .join(" | ");
  const lines = [headline];
  if (metadata) {
    lines.push(platform === "slack" ? `  _${sanitizeSlackText(metadata)}_` : `  _${sanitizeWhatsAppInline(metadata)}_`);
  }
  if (platform === "whatsapp" && item.sourceUrl) lines.push(`  Source: ${item.sourceUrl}`);
  return lines.join("\n");
}

export function renderAgentOutputForDelivery(params: {
  title: string;
  sections: readonly AgentSectionDef[];
  output: RenderableAgentOutput;
  platform: AgentDeliveryRenderPlatform;
  mentions?: readonly AgentDeliveryMention[];
}): string {
  const header = `${params.title} | ${formatOutputDate(params.output.outputDate)}`;
  const lines: string[] = [`*${header}*`];
  const mentions = (params.mentions ?? []).flatMap((mention) => {
    const formatted = formatMention(mention, params.platform);
    return formatted ? [formatted] : [];
  });
  if (mentions.length > 0) lines.push(`Cc: ${mentions.join(", ")}`);

  const summary = params.output.masthead?.summary?.trim();
  if (summary) {
    const clipped = clip(summary, MASTHEAD_SUMMARY_LIMIT);
    lines.push("", params.platform === "slack" ? sanitizeSlackText(clipped) : clipped);
  }

  for (const section of params.sections) {
    const items = params.output.sections[section.key] ?? [];
    if (items.length === 0) continue;
    lines.push("", `*${section.title}*`);
    for (const item of items) {
      lines.push(formatItem(item, params.platform, params.output.sourceLabel));
    }
  }

  return lines.join("\n").trim();
}
