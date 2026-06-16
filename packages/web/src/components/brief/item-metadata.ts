import type { DailyBriefItem } from "@/lib/api";

export const LABEL_META: Record<
  DailyBriefItem["sectionKey"],
  Record<string, { label: string; dot: string; eyebrow: string }>
> = {
  todos: {
    todo: { label: "Todo", dot: "bg-muted-foreground/40", eyebrow: "Task" },
    in_progress: { label: "In Progress", dot: "bg-amber-400", eyebrow: "Task" },
    blocked: { label: "Blocked", dot: "bg-red-500", eyebrow: "Task" },
    waiting: { label: "Waiting", dot: "bg-sky-400", eyebrow: "Task" },
    done: { label: "Done", dot: "bg-emerald-500", eyebrow: "Task" },
  },
  customer_updates: {
    owed_follow_up: { label: "Owed follow-up", dot: "bg-red-500", eyebrow: "Customer update" },
    warm: { label: "Warm", dot: "bg-amber-400", eyebrow: "Customer update" },
    inbound: { label: "Inbound", dot: "bg-emerald-500", eyebrow: "Customer update" },
    stuck: { label: "Stuck", dot: "bg-orange-400", eyebrow: "Customer update" },
    cold: { label: "Cold", dot: "bg-sky-400", eyebrow: "Customer update" },
    at_risk: { label: "At risk", dot: "bg-red-500", eyebrow: "Customer update" },
  },
  active_projects: {
    active: { label: "Active", dot: "bg-emerald-500", eyebrow: "Project" },
    at_risk: { label: "At risk", dot: "bg-red-500", eyebrow: "Project" },
    blocked: { label: "Blocked", dot: "bg-red-500", eyebrow: "Project" },
    needs_attention: { label: "Needs attention", dot: "bg-amber-400", eyebrow: "Project" },
  },
};

export function labelMeta(item: DailyBriefItem) {
  return (
    LABEL_META[item.sectionKey][item.label] ?? {
      label: item.label,
      dot: "bg-muted-foreground/40",
      eyebrow: item.sectionKey.replaceAll("_", " "),
    }
  );
}

export function actionLabelForItem(item: DailyBriefItem): string {
  if (item.sectionKey === "active_projects") return "Catch me up";
  if (item.sectionKey === "todos") {
    if (item.label === "blocked") return "Unblock with Sketch";
    if (item.label === "done") return "Review with Sketch";
    return "Plan with Sketch";
  }
  return item.actionLabel ?? "Ask Sketch";
}

export function sourceLinkLabel(url: string): string {
  if (url.includes("fireflies")) return "Open in Fireflies";
  if (url.includes("linear.app")) return "Open in Linear";
  if (url.includes("mail.google")) return "Open in Gmail";
  if (url.includes("clickup")) return "Open in ClickUp";
  if (url.includes("jira")) return "Open in Jira";
  return "Open source";
}

export function refChips(item: DailyBriefItem): string[] {
  const refs = item.knowledgeRefs;
  const chips = [
    ...(item.displayRef ? [item.displayRef] : []),
    ...(refs.factIds?.map((id) => `FACT-${id.replaceAll("-", "").slice(0, 6)}`) ?? []),
    ...refs.fileIds.map((id) => `FILE-${id.replaceAll("-", "").slice(0, 6)}`),
    ...refs.entityIds.map((id) => `ENT-${id.replaceAll("-", "").slice(0, 6)}`),
  ];
  return [...new Set(chips)].slice(0, 6);
}
