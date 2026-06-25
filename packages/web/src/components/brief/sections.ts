import type { DailyBrief } from "@/lib/api";

export type BriefSectionKey = keyof DailyBrief["sections"];

export interface BriefSectionMeta {
  key: BriefSectionKey;
  label: string;
  promise: string;
}

export const BRIEF_SECTIONS: BriefSectionMeta[] = [
  {
    key: "todos",
    label: "Top to-dos",
    promise: "Your most pressing tasks, pulled from your tools and ranked for today.",
  },
  {
    key: "customer_updates",
    label: "Customer Updates",
    promise: "Movement on the accounts and deals that matter, summarized for you.",
  },
  {
    key: "active_projects",
    label: "Active Projects",
    promise: "Where your live projects stand and what needs a nudge.",
  },
];
