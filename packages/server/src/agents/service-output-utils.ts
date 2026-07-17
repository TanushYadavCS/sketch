import type { WriteAgentOutputPayload } from "../agent/tools/agent-output";
import type { AgentRoute, AgentRouteSchedule, AgentSourceConfig } from "../db/repositories/agent-outputs";
import type { AgentApiItem, AgentDefinition } from "./types";

const ROUTE_INTERVAL_HOURS = new Set([1, 2, 3, 4, 6, 8, 12]);
const WEEKDAY_INDEX = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
]);

function isSummaryWindow(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).start === "string" &&
    typeof (value as Record<string, unknown>).end === "string"
  );
}

export function rawPayloadWithRunMetadata(
  rawPayload: WriteAgentOutputPayload,
  runtimeContext: Record<string, unknown>,
): WriteAgentOutputPayload | (WriteAgentOutputPayload & { summaryWindow: Record<string, unknown> }) {
  const summaryWindow = runtimeContext.summaryWindow;
  return isSummaryWindow(summaryWindow) ? { ...rawPayload, summaryWindow } : rawPayload;
}

export function localDateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function localSchedulePartsInTimezone(
  now: Date,
  timezone: string,
): {
  date: string;
  dayOfWeek: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  return {
    date: `${year}-${month}-${day}`,
    dayOfWeek: WEEKDAY_INDEX.get(weekday) ?? 0,
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0"),
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? "0"),
  };
}

/**
 * Returns the scheduler de-dup bucket when a route is due in the user's local
 * timezone. Completed output history remains append-only; this key coalesces the
 * common single-process scheduled path per route scope and period.
 */
export function computeDuePeriodKey(
  schedule: AgentRouteSchedule | ({ hour: number; minute: number } & Partial<AgentRouteSchedule>),
  now: Date,
  timezone: string,
): string | null {
  const local = localSchedulePartsInTimezone(now, timezone);
  const frequency = schedule.frequency ?? "daily";
  if (frequency === "daily") {
    return local.hour === schedule.hour && local.minute >= schedule.minute ? local.date : null;
  }
  if (frequency === "weekly") {
    return local.hour === schedule.hour &&
      local.minute >= schedule.minute &&
      Array.isArray(schedule.daysOfWeek) &&
      schedule.daysOfWeek.includes(local.dayOfWeek)
      ? local.date
      : null;
  }
  const intervalHours = schedule.intervalHours ?? 0;
  if (!ROUTE_INTERVAL_HOURS.has(intervalHours)) return null;
  return local.hour % intervalHours === 0 && local.minute >= schedule.minute
    ? `${local.date}T${String(local.hour).padStart(2, "0")}`
    : null;
}

export function firstRunLookbackHoursForSchedule(schedule: AgentRouteSchedule | null | undefined): number {
  if (!schedule || schedule.frequency === "daily") return 24;
  if (schedule.frequency === "weekly") return 168;
  return schedule.intervalHours ?? 24;
}

/** The platform a route delivers to, so the agent can tailor its prose; null for off/web-only routes. */
export function deliveryPlatformForRoute(
  route: AgentRoute | null | undefined,
  resolvedSources: AgentSourceConfig[],
): "slack" | "whatsapp" | null {
  const destination = route?.destination;
  if (destination && (destination.kind === "channel" || destination.kind === "member")) return destination.platform;
  if (destination?.kind === "self" && resolvedSources.length === 1) return resolvedSources[0].platform;
  return null;
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function timestampAgeMs(value: string, now: Date): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return now.getTime() - parsed;
}

export function isOlderThan(value: string, now: Date, thresholdMs: number): boolean {
  const age = timestampAgeMs(value, now);
  return age !== null && age >= thresholdMs;
}

export function isNewerThan(value: string, now: Date, thresholdMs: number): boolean {
  const age = timestampAgeMs(value, now);
  return age !== null && age >= 0 && age < thresholdMs;
}

export function emptySections(def: AgentDefinition): Record<string, AgentApiItem[]> {
  const sections: Record<string, AgentApiItem[]> = {};
  for (const section of def.sections) sections[section.key] = [];
  return sections;
}
