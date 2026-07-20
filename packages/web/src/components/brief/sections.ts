import type { DailyBrief } from "@/lib/api";

export type BriefSectionKey = keyof DailyBrief["sections"];

export interface BriefSectionMeta {
  key: BriefSectionKey;
  label: string;
  promise: string;
}

export const BRIEF_SECTIONS: BriefSectionMeta[] = [
  {
    key: "meetings",
    label: "Today's meetings",
    promise: "Your calendar for today, with who's in the room and why they matter.",
  },
  {
    key: "todos",
    label: "Top to-dos",
    promise: "Your most pressing tasks, pulled from your tools and ranked for today.",
  },
  {
    key: "untracked_followups",
    label: "Untracked follow-ups",
    promise: "Recent follow-ups reconstructed from summaries for you to track or dismiss.",
  },
  {
    key: "looks_resolved",
    label: "Looks resolved",
    promise: "Follow-ups that may be complete and are waiting for your confirmation.",
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
