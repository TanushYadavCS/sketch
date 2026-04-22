import { cn } from "@sketch/ui/lib/utils";

export type TimePeriod = "Week" | "Month" | "Quarter";
export type AdminTab = "team" | "my-usage";

export const PERIOD_MAP: Record<TimePeriod, "weekly" | "monthly" | "quarterly"> = {
  Week: "weekly",
  Month: "monthly",
  Quarter: "quarterly",
};

export interface ByUserEntry {
  userId: string;
  userName: string | null;
  userType: string;
  messageCount: number;
  costUsd: number;
  skillCount: number;
  lastRunAt: string | null;
}

export interface ByGroupEntry {
  workspaceKey: string;
  name: string;
  platform: "slack" | "whatsapp";
  messageCount: number;
  skillCount: number;
  lastRunAt: string | null;
}

export function formatPeriodLabel(period: { from: string; to: string; type: string }): string {
  const from = new Date(period.from);
  const lastDay = new Date(new Date(period.to).getTime() - 24 * 60 * 60 * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${from.toLocaleDateString("en-US", opts)} – ${lastDay.toLocaleDateString("en-US", opts)}`;
}

export function formatLastActive(isoDate: string | null): string {
  if (!isoDate) return "Never";
  const now = new Date();
  const d = new Date(isoDate);
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return `${diffDays}d ago`;
}

export function TimeFilter({ value, onChange }: { value: TimePeriod; onChange: (v: TimePeriod) => void }) {
  const options: TimePeriod[] = ["Week", "Month", "Quarter"];
  return (
    <div className="inline-flex rounded-lg border-[0.5px] border-border bg-card p-0.5 dark:bg-[#111110]">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={cn(
            "rounded-md px-3 py-1 text-xs transition-colors",
            value === opt
              ? "bg-accent font-medium text-foreground dark:bg-[#1C1C1A]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export function GroupAvatar({ name }: { name: string }) {
  const initial = name[0]?.toUpperCase() ?? "G";
  return (
    <div className="flex size-[24px] shrink-0 items-center justify-center rounded-[6px] border-[0.5px] border-border bg-muted text-[9px] font-medium text-muted-foreground dark:bg-muted/50">
      {initial}
    </div>
  );
}

export function ActivityBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-[7px] w-[80px] overflow-hidden rounded-[4px] bg-[#B4B2A9] dark:bg-[#4A4840]">
        {pct > 0 ? <div className="h-full rounded-[4px] bg-[#FEED01]" style={{ width: `${pct}%` }} /> : null}
      </div>
    </div>
  );
}

export function AvatarChip({ name, type = "member" }: { name: string; type?: "member" | "agent" }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        "flex size-[24px] shrink-0 items-center justify-center rounded-full text-[9px] font-medium",
        type === "agent"
          ? "border-[0.5px] border-dashed border-muted-foreground/40 bg-muted text-muted-foreground dark:bg-muted/50"
          : "border-[0.5px] border-border bg-muted text-muted-foreground dark:bg-muted/50",
      )}
    >
      {initials}
    </div>
  );
}

function ChannelIcon({ platform }: { platform: "slack" | "whatsapp" | "email" }) {
  if (platform === "slack")
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" className="shrink-0" fill="#4A154B" aria-hidden="true">
        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
      </svg>
    );
  if (platform === "whatsapp")
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" className="shrink-0" fill="#25D366" aria-hidden="true">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" />
      </svg>
    );
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      className="shrink-0 text-muted-foreground"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z" />
    </svg>
  );
}

export function ActivityByChannel({
  channels,
  title = "Activity by channel",
}: {
  channels: Array<{ platform: "slack" | "whatsapp" | "email"; label: string; count: number; pct: number }>;
  title?: string;
}) {
  const maxCount = Math.max(...channels.map((c) => c.count), 1);

  if (channels.length === 0) {
    return (
      <div>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
        <p className="text-[13px] text-muted-foreground">No channel activity yet</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
      <div className="space-y-3">
        {channels.map((ch) => (
          <div key={ch.platform} className="flex items-center gap-2.5">
            <div className="flex w-[90px] items-center gap-2 text-[13px] text-foreground">
              <ChannelIcon platform={ch.platform} />
              <span>{ch.label}</span>
            </div>
            <div className="h-[7px] flex-1 overflow-hidden rounded-[4px] bg-[#B4B2A9] dark:bg-[#4A4840]">
              <div className="h-full rounded-[4px] bg-[#FEED01]" style={{ width: `${(ch.count / maxCount) * 100}%` }} />
            </div>
            <span className="w-[28px] text-right font-mono text-[11px] tabular-nums text-foreground">{ch.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TopSkills({
  skills,
  title = "Top skills",
}: {
  skills: Array<{ name: string; category: string; count: number }>;
  title?: string;
}) {
  if (skills.length === 0) {
    return (
      <div>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
        <p className="text-[13px] text-muted-foreground">No skills used yet</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
      <div className="space-y-2.5">
        {skills.map((skill) => (
          <div key={skill.name} className="flex items-center justify-between">
            <div>
              <p className={cn("text-[13px] font-medium", skill.count === 0 && "italic text-muted-foreground")}>
                {skill.name}
              </p>
              {skill.category ? <p className="text-[11px] text-muted-foreground">{skill.category}</p> : null}
            </div>
            <span className="font-mono text-[12px] tabular-nums">
              <span className={cn("font-medium", skill.count === 0 && "text-muted-foreground")}>{skill.count}</span>
              <span className="text-muted-foreground">&times;</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
