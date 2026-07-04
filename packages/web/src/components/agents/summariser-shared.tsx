/**
 * Shared building blocks for editing a summariser (an AgentRoute on a
 * source-backed agent). A summariser maps one or more input conversations to a
 * delivery, schedule, sections, focus, and volume. These primitives are reused
 * by the roster sub-rows, the new-summariser modal, and the per-summariser
 * config page so the vocabulary stays consistent everywhere.
 */
import {
  type AgentConfig,
  type AgentRoute,
  type AgentRouteDestination,
  type AgentRouteFrequency,
  type AgentSourceConfig,
  type AgentSourceKey,
  api,
} from "@/lib/api";
import { CheckCircleIcon, MagnifyingGlassIcon, SlackLogoIcon, UserIcon, WhatsappLogoIcon } from "@phosphor-icons/react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Switch } from "@sketch/ui/components/switch";
import { TabButton } from "@sketch/ui/components/tab-button";
import { cn } from "@sketch/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function sourceKey(source: AgentSourceConfig): string {
  return `${source.platform}:${source.targetType}:${source.targetId}`;
}

export function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDaysOfWeek(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  return [...set]
    .sort((a, b) => a - b)
    .map((day) => SHORT_DAY_NAMES[day])
    .join(", ");
}

/** Human-readable summary of a route's schedule, frequency-aware, for read-only rows. */
export function scheduleSummary(route: AgentRoute, agent: AgentConfig): string {
  const schedule = route.schedule;
  const hour = schedule?.hour ?? agent.scheduleHour;
  const minute = schedule?.minute ?? agent.scheduleMinute;
  if (schedule?.frequency === "weekly" && schedule.daysOfWeek?.length) {
    return `${formatDaysOfWeek(schedule.daysOfWeek)} at ${formatTime(hour, minute)}`;
  }
  if (schedule?.frequency === "every_n_hours" && schedule.intervalHours) {
    const unit = schedule.intervalHours === 1 ? "hour" : `${schedule.intervalHours} hours`;
    return `Every ${unit} at :${String(minute).padStart(2, "0")}`;
  }
  return `Every day at ${formatTime(hour, minute)}`;
}

export function deliversLabel(route: AgentRoute): string {
  const dest = route.destination;
  if (dest.kind === "self") return "Post back";
  if (dest.kind === "member") return "Direct message";
  if (dest.kind === "channel") return dest.label ?? (dest.platform === "slack" ? "Slack channel" : "WhatsApp group");
  return "Web only";
}

/** Narrows a selected input-shaped target into a channel destination, honoring the slack↔channel / whatsapp↔group pairing. */
function channelDestination(target: AgentSourceConfig): AgentRouteDestination {
  return target.platform === "slack"
    ? { kind: "channel", platform: "slack", targetType: "channel", targetId: target.targetId, label: target.label }
    : { kind: "channel", platform: "whatsapp", targetType: "group", targetId: target.targetId, label: target.label };
}

export function sectionsLabel(route: AgentRoute, agent: AgentConfig): string {
  const on = agent.sections.filter((section) => route.sections?.[section.key] ?? section.enabled);
  if (on.length === agent.sections.length) return "All sections";
  if (on.length === 0) return "No sections";
  return on.map((section) => section.title).join(", ");
}

export function routesToSources(routes: AgentRoute[], lookup: Map<string, AgentSourceConfig>): AgentSourceConfig[] {
  const out: AgentSourceConfig[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    for (const key of route.sources) {
      if (seen.has(key)) continue;
      const source = lookup.get(key);
      if (source) {
        seen.add(key);
        out.push(source);
      }
    }
  }
  return out;
}

export function defaultSections(agent: AgentConfig, route: AgentRoute | null): Record<string, boolean> {
  const record: Record<string, boolean> = {};
  for (const section of agent.sections) record[section.key] = route?.sections?.[section.key] ?? section.enabled;
  return record;
}

/** Resolves a route's first source to a display label + platform, with a count of any combined extras. */
export function routeInput(
  route: Pick<AgentRoute, "sources">,
  lookup: Map<string, AgentSourceConfig>,
): { label: string; platform: "slack" | "whatsapp" | null; extra: number } {
  const first = route.sources[0] ? lookup.get(route.sources[0]) : undefined;
  return {
    label: first?.label ?? route.sources[0] ?? "No input",
    platform: first?.platform ?? null,
    extra: Math.max(0, route.sources.length - 1),
  };
}

/** Fetches the selectable Slack/WhatsApp inputs and builds a key→source lookup that also covers already-saved sources. */
export function useSourceOptions(agent: AgentConfig) {
  const slackChannels = useQuery({ queryKey: ["slack-channels"], queryFn: () => api.channels.listSlack() });
  const whatsappGroups = useQuery({ queryKey: ["whatsapp-groups"], queryFn: () => api.channels.listWhatsAppGroups() });

  const slackOptions = (slackChannels.data?.channels ?? [])
    .filter((channel) => channel.isMember)
    .map(
      (channel): AgentSourceConfig => ({
        platform: "slack",
        targetType: "channel",
        targetId: channel.id,
        label: `#${channel.name}`,
      }),
    );
  const whatsappOptions = (whatsappGroups.data?.groups ?? []).map(
    (group): AgentSourceConfig => ({
      platform: "whatsapp",
      targetType: "group",
      targetId: group.jid,
      label: group.name,
    }),
  );

  const lookup = new Map<string, AgentSourceConfig>();
  for (const source of [...agent.sources, ...slackOptions, ...whatsappOptions]) lookup.set(sourceKey(source), source);

  return {
    slackLoading: slackChannels.isLoading,
    whatsappLoading: whatsappGroups.isLoading,
    slackOptions,
    whatsappOptions,
    lookup,
  };
}

export interface RouteDraftController {
  sources: AgentSourceKey[];
  destKind: AgentRouteDestination["kind"];
  memberUserId: string | null;
  channelTarget: AgentSourceConfig | null;
  frequency: AgentRouteFrequency;
  hour: number;
  minute: number;
  daysOfWeek: number[];
  intervalHours: number;
  sections: Record<string, boolean>;
  focus: string;
  volume: number;
  combined: boolean;
  hasWhatsApp: boolean;
  isValid: boolean;
  toggleSource: (source: AgentSourceConfig) => void;
  setDestKind: (kind: AgentRouteDestination["kind"]) => void;
  setMemberUserId: (id: string | null) => void;
  setChannelTarget: (target: AgentSourceConfig | null) => void;
  setFrequency: (v: AgentRouteFrequency) => void;
  setHour: (v: number) => void;
  setMinute: (v: number) => void;
  toggleDayOfWeek: (day: number) => void;
  setIntervalHours: (v: number) => void;
  setSection: (key: string, on: boolean) => void;
  setFocus: (v: string) => void;
  setVolume: (v: number) => void;
  build: (base: AgentRoute | null) => AgentRoute;
}

/** Local editable state for one summariser, seeded from an existing route or blank for a new one. */
export function useRouteDraft(agent: AgentConfig, route: AgentRoute | null): RouteDraftController {
  const maxSources = agent.sourceConfig?.maxSources ?? 0;
  const [sources, setSources] = useState<AgentSourceKey[]>(route?.sources ?? []);
  const [destKind, setDestKind] = useState<AgentRouteDestination["kind"]>(route?.destination.kind ?? "channel");
  const [memberUserId, setMemberUserId] = useState<string | null>(
    route?.destination.kind === "member" ? route.destination.memberUserId : null,
  );
  const [channelTarget, setChannelTarget] = useState<AgentSourceConfig | null>(
    route?.destination.kind === "channel"
      ? {
          platform: route.destination.platform,
          targetType: route.destination.targetType,
          targetId: route.destination.targetId,
          label: route.destination.label,
        }
      : null,
  );
  const [frequency, setFrequency] = useState<AgentRouteFrequency>(route?.schedule?.frequency ?? "daily");
  const [hour, setHour] = useState(route?.schedule?.hour ?? agent.scheduleHour);
  const [minute, setMinute] = useState(route?.schedule?.minute ?? agent.scheduleMinute);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(route?.schedule?.daysOfWeek ?? [1]);
  const [intervalHours, setIntervalHours] = useState(route?.schedule?.intervalHours ?? 4);
  const [sections, setSections] = useState<Record<string, boolean>>(defaultSections(agent, route));
  const [focus, setFocus] = useState(route?.focus ?? "");
  const [volume, setVolume] = useState(route?.maxItemsPerSection ?? agent.maxItemsPerSection);

  const combined = sources.length > 1;
  const hasWhatsApp = sources.some((key) => key.startsWith("whatsapp:"));

  useEffect(() => {
    if (destKind === "self" && sources.length > 1) setDestKind("channel");
  }, [destKind, sources.length]);

  const toggleSource = (source: AgentSourceConfig) => {
    const key = sourceKey(source) as AgentSourceKey;
    if (sources.includes(key)) {
      setSources(sources.filter((item) => item !== key));
      return;
    }
    if (maxSources > 0 && sources.length >= maxSources) return;
    setSources([...sources, key]);
  };

  const toggleDayOfWeek = (day: number) => {
    setDaysOfWeek((prev) => (prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day].sort()));
  };

  const isValid =
    sources.length > 0 &&
    !(destKind === "self" && sources.length !== 1) &&
    !(destKind === "member" && !memberUserId) &&
    !(destKind === "channel" && !channelTarget) &&
    !(frequency === "weekly" && daysOfWeek.length === 0);

  const build = (base: AgentRoute | null): AgentRoute => {
    const destination: AgentRouteDestination =
      destKind === "self"
        ? { kind: "self" }
        : destKind === "member" && memberUserId
          ? { kind: "member", platform: hasWhatsApp ? "whatsapp" : "slack", memberUserId }
          : destKind === "channel" && channelTarget
            ? channelDestination(channelTarget)
            : { kind: "off" };
    return {
      id: base?.id ?? crypto.randomUUID(),
      sources,
      focus: focus.trim() ? focus.trim() : null,
      sections,
      maxItemsPerSection: volume,
      schedule:
        frequency === "weekly"
          ? { frequency, hour, minute, daysOfWeek }
          : frequency === "every_n_hours"
            ? { frequency, hour, minute, intervalHours }
            : { frequency, hour, minute },
      destination,
      enabled: base?.enabled ?? true,
    };
  };

  return {
    sources,
    destKind,
    memberUserId,
    channelTarget,
    frequency,
    hour,
    minute,
    daysOfWeek,
    intervalHours,
    sections,
    focus,
    volume,
    combined,
    hasWhatsApp,
    isValid,
    toggleSource,
    setDestKind,
    setMemberUserId,
    setChannelTarget,
    setFrequency,
    setHour,
    setMinute,
    toggleDayOfWeek,
    setIntervalHours,
    setSection: (key, on) => setSections((prev) => ({ ...prev, [key]: on })),
    setFocus,
    setVolume,
    build,
  };
}

const LABEL = "font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70";

export function SourcesField({ agent, controller }: { agent: AgentConfig; controller: RouteDraftController }) {
  const selected = new Set<string>(controller.sources);
  const maxSources = agent.sourceConfig?.maxSources ?? 0;
  const atMax = maxSources > 0 && controller.sources.length >= maxSources;
  return (
    <div className="space-y-2">
      <ChannelPickerList
        agent={agent}
        selected={selected}
        onToggle={controller.toggleSource}
        showSlack={agent.sourceConfig?.supportsSlackChannels ?? false}
        showWhatsapp={agent.sourceConfig?.supportsWhatsAppGroups ?? false}
        isDisabled={atMax ? () => true : undefined}
      />
      <p className={LABEL}>
        {controller.sources.length} selected
        {maxSources > 0 ? ` · limit ${maxSources}` : ""}
        {controller.combined ? " · combined into one summary" : ""}
      </p>
    </div>
  );
}

export function DestinationField({
  agent,
  agentKey,
  controller,
}: {
  agent: AgentConfig;
  agentKey: string;
  controller: RouteDraftController;
}) {
  const { destKind, memberUserId, hasWhatsApp } = controller;
  const activeTab: "groups" | "dm" = destKind === "member" ? "dm" : "groups";
  const dmPlatform: "slack" | "whatsapp" = hasWhatsApp ? "whatsapp" : "slack";
  const slackDmSupported = agent.sourceConfig?.supportsSlackChannels ?? false;

  const slackMemberQuery = useQuery({
    queryKey: ["route-members", agentKey, controller.sources],
    queryFn: () => api.agents.routeMembers(agentKey, controller.sources),
    enabled: activeTab === "dm" && dmPlatform === "slack" && slackDmSupported && controller.sources.length > 0,
  });
  const whatsappMemberQuery = useQuery({
    queryKey: ["whatsapp-dm-members", agentKey],
    queryFn: () => api.agents.whatsappDmMembers(agentKey),
    enabled: activeTab === "dm" && dmPlatform === "whatsapp",
  });

  const channelSelected = controller.channelTarget
    ? new Set<string>([sourceKey(controller.channelTarget)])
    : new Set<string>();

  const toggleChannel = (option: AgentSourceConfig) => {
    const same = controller.channelTarget != null && sourceKey(controller.channelTarget) === sourceKey(option);
    controller.setChannelTarget(same ? null : option);
    if (!same) controller.setDestKind("channel");
  };

  return (
    <div>
      <div className="flex items-center gap-6 border-b border-border">
        <TabButton
          label="Groups"
          isActive={activeTab === "groups"}
          onClick={() => {
            if (destKind === "member") controller.setDestKind("channel");
          }}
        />
        <TabButton label="DM" isActive={activeTab === "dm"} onClick={() => controller.setDestKind("member")} />
      </div>

      {activeTab === "groups" ? (
        <div className="mt-3">
          <ChannelPickerList agent={agent} selected={channelSelected} onToggle={toggleChannel} />
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
            Posts to any channel or group Sketch can reach — independent of the inputs above.
          </p>
        </div>
      ) : dmPlatform === "whatsapp" ? (
        <div className="mt-3">
          <TargetList
            loading={whatsappMemberQuery.isLoading}
            empty="No teammate has a WhatsApp number yet. Add one on their profile and reload."
            selectedId={memberUserId ?? ""}
            options={(whatsappMemberQuery.data?.members ?? []).map((member) => ({
              id: member.userId,
              label: member.name,
              icon: <UserIcon size={14} aria-hidden />,
            }))}
            onSelect={(id) => controller.setMemberUserId(id)}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
            DMs any teammate who has a WhatsApp number — independent of the inputs above.
          </p>
        </div>
      ) : !slackDmSupported ? (
        <p className="mt-3 px-1 py-2 text-[12px] text-muted-foreground">
          Member DM isn't available for this summariser.
        </p>
      ) : (
        <div className="mt-3">
          <TargetList
            loading={slackMemberQuery.isLoading}
            empty="No member is in every selected source."
            selectedId={memberUserId ?? ""}
            options={(slackMemberQuery.data?.members ?? []).map((member) => ({
              id: member.userId,
              label: member.name,
              icon: <UserIcon size={14} aria-hidden />,
            }))}
            onSelect={(id) => controller.setMemberUserId(id)}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
            Only members of every selected source appear — the summary can never reach someone outside the inputs.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Shared search-and-add list over the Slack channels and WhatsApp groups Sketch
 * can reach, split into a section per source. Used for both the multi-select
 * inputs and the single-select delivery target — the caller owns the selection
 * set (keyed by sourceKey) and the toggle handler.
 */
export function ChannelPickerList({
  agent,
  selected,
  onToggle,
  showSlack = true,
  showWhatsapp = true,
  isDisabled,
}: {
  agent: AgentConfig;
  selected: Set<string>;
  onToggle: (option: AgentSourceConfig) => void;
  showSlack?: boolean;
  showWhatsapp?: boolean;
  isDisabled?: (option: AgentSourceConfig) => boolean;
}) {
  const { slackLoading, whatsappLoading, slackOptions, whatsappOptions } = useSourceOptions(agent);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const match = (o: AgentSourceConfig) => !q || (o.label ?? o.targetId).toLowerCase().includes(q);

  return (
    <div className="space-y-2">
      <div className="relative">
        <MagnifyingGlassIcon
          size={13}
          aria-hidden
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search channels & groups…"
          className="w-full rounded-md border-[0.5px] border-border bg-background py-1.5 pl-7 pr-2 text-[12px] text-foreground placeholder:text-muted-foreground focus:border-foreground/30 focus:outline-none"
        />
      </div>

      <div className="max-h-56 space-y-3 overflow-y-auto rounded-lg border-[0.5px] border-border p-2">
        {showSlack ? (
          <ChannelSection
            title="Slack channels"
            loading={slackLoading}
            total={slackOptions.length}
            options={slackOptions.filter(match)}
            selected={selected}
            onToggle={onToggle}
            isDisabled={isDisabled}
            empty="The bot isn't in any Slack channels yet."
          />
        ) : null}
        {showWhatsapp ? (
          <ChannelSection
            title="WhatsApp groups"
            loading={whatsappLoading}
            total={whatsappOptions.length}
            options={whatsappOptions.filter(match)}
            selected={selected}
            onToggle={onToggle}
            isDisabled={isDisabled}
            empty="The bot isn't in any WhatsApp groups yet — add it to a group and reload."
          />
        ) : null}
      </div>
    </div>
  );
}

/** One platform's rows inside the channel picker, always shown so an empty list carries its own explanation. */
function ChannelSection({
  title,
  loading,
  total,
  options,
  selected,
  onToggle,
  isDisabled,
  empty,
}: {
  title: string;
  loading: boolean;
  total: number;
  options: AgentSourceConfig[];
  selected: Set<string>;
  onToggle: (option: AgentSourceConfig) => void;
  isDisabled?: (option: AgentSourceConfig) => boolean;
  empty: string;
}) {
  return (
    <div>
      <span className={LABEL}>{title}</span>
      {loading ? (
        <p className="px-1 py-1.5 text-[12px] text-muted-foreground">Loading…</p>
      ) : total === 0 ? (
        <p className="px-1 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{empty}</p>
      ) : options.length === 0 ? (
        <p className="px-1 py-1.5 text-[11.5px] text-muted-foreground">No matches.</p>
      ) : (
        <div className="mt-1 flex flex-col">
          {options.map((option) => {
            const key = sourceKey(option);
            const active = selected.has(key);
            const disabled = !active && (isDisabled?.(option) ?? false);
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => onToggle(option)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
                  active ? "bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:bg-muted/60",
                  disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
              >
                <span className="shrink-0">
                  {option.platform === "slack" ? (
                    <SlackLogoIcon size={14} aria-hidden />
                  ) : (
                    <WhatsappLogoIcon size={14} aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label ?? option.targetId}</span>
                {active ? <CheckCircleIcon size={13} weight="fill" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const INTERVAL_OPTIONS = [1, 2, 3, 4, 6, 8, 12];

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border-[0.5px] border-border bg-card p-0.5 dark:bg-[#111110]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1 text-xs transition-colors",
            value === option.value
              ? "bg-accent font-medium text-foreground dark:bg-[#1C1C1A]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ScheduleChip({
  label,
  title,
  isActive,
  onClick,
}: {
  label: string;
  title?: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-8 min-w-8 items-center justify-center rounded-lg border-[0.5px] px-2.5 text-[12.5px] font-medium transition-colors",
        isActive
          ? "border-foreground/20 bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function AnchorTime({ controller }: { controller: RouteDraftController }) {
  return (
    <div className="flex items-center gap-2">
      <NumberField label="Hour" min={0} max={23} value={controller.hour} onChange={controller.setHour} />
      <span className="mt-5 text-muted-foreground">:</span>
      <NumberField label="Minute" min={0} max={59} value={controller.minute} onChange={controller.setMinute} />
      <span className="mt-5 ml-2 text-[12.5px] text-muted-foreground">
        {formatTime(controller.hour, controller.minute)}
      </span>
    </div>
  );
}

export function ScheduleField({ controller }: { controller: RouteDraftController }) {
  const { frequency, intervalHours, minute } = controller;
  return (
    <div>
      <span className={LABEL}>Frequency</span>
      <div className="mt-2">
        <SegmentedControl
          value={frequency}
          onChange={controller.setFrequency}
          options={[
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "every_n_hours", label: "Hourly" },
          ]}
        />
      </div>

      {frequency === "daily" && (
        <div className="mt-3">
          <span className={LABEL}>Runs at</span>
          <div className="mt-2">
            <AnchorTime controller={controller} />
          </div>
        </div>
      )}

      {frequency === "weekly" && (
        <div className="mt-3 space-y-3">
          <div>
            <span className={LABEL}>On days</span>
            <div className="mt-2 flex gap-1.5">
              {DAY_LABELS.map((label, index) => (
                <ScheduleChip
                  key={DAY_NAMES[index]}
                  label={label}
                  title={DAY_NAMES[index]}
                  isActive={controller.daysOfWeek.includes(index)}
                  onClick={() => controller.toggleDayOfWeek(index)}
                />
              ))}
            </div>
            {controller.daysOfWeek.length === 0 && (
              <p className="mt-1.5 text-[11px] text-amber-600">Pick at least one day.</p>
            )}
          </div>
          <div>
            <span className={LABEL}>Runs at</span>
            <div className="mt-2">
              <AnchorTime controller={controller} />
            </div>
          </div>
        </div>
      )}

      {frequency === "every_n_hours" && (
        <div className="mt-3 flex items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Every</span>
            <Select value={String(intervalHours)} onValueChange={(value) => controller.setIntervalHours(Number(value))}>
              <SelectTrigger aria-label="Interval" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVAL_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option === 1 ? "1 hour" : `${option} hours`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <NumberField label="At minute" min={0} max={59} value={minute} onChange={controller.setMinute} />
          <span className="mb-2.5 text-[12.5px] text-muted-foreground">
            Runs at :{String(minute).padStart(2, "0")} every {intervalHours === 1 ? "hour" : `${intervalHours} hours`},
            from midnight
          </span>
        </div>
      )}
    </div>
  );
}

export function SectionsField({ agent, controller }: { agent: AgentConfig; controller: RouteDraftController }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className={LABEL}>Sections</span>
        <span className="text-[11px] text-muted-foreground/70">turn on only what you want</span>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {agent.sections.map((section) => (
          <div
            key={section.key}
            className="flex items-center gap-3 rounded-xl border-[0.5px] border-border bg-card px-4 py-3"
          >
            <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground">{section.title}</p>
            <Switch
              checked={controller.sections[section.key] ?? section.enabled}
              onCheckedChange={(on) => controller.setSection(section.key, on)}
              aria-label={section.title}
              className="data-[state=checked]:bg-emerald-500"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FocusField({ controller }: { controller: RouteDraftController }) {
  return (
    <div>
      <span className={LABEL}>Focus</span>
      <textarea
        rows={2}
        value={controller.focus}
        onChange={(e) => controller.setFocus(e.target.value)}
        placeholder="e.g. anything blocking delivery for this group"
        className="mt-2 w-full resize-none rounded-lg border-[0.5px] border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed text-foreground/90 placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
      />
    </div>
  );
}

export function VolumeField({ agent, controller }: { agent: AgentConfig; controller: RouteDraftController }) {
  return (
    <div>
      <span className={LABEL}>Volume</span>
      <div className="mt-2">
        <NumberField
          label="Items per section"
          min={agent.itemsPerSectionRange.min}
          max={agent.itemsPerSectionRange.max}
          value={controller.volume}
          onChange={controller.setVolume}
        />
      </div>
    </div>
  );
}

export function SourceGroup({
  title,
  loading,
  empty,
  selected,
  options,
  onToggle,
}: {
  title: string;
  loading: boolean;
  empty: string;
  selected: Set<string>;
  options: AgentSourceConfig[];
  onToggle: (source: AgentSourceConfig) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => (o.label ?? o.targetId).toLowerCase().includes(q)) : options;
  const showSearch = options.length > 6;

  return (
    <div>
      <span className={LABEL}>{title}</span>
      <div className="mt-2 rounded-lg border-[0.5px] border-border p-1">
        {loading ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading...</p>
        ) : options.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">{empty}</p>
        ) : (
          <>
            {showSearch ? (
              <div className="relative mb-1">
                <MagnifyingGlassIcon
                  size={13}
                  aria-hidden
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${title.toLowerCase()}…`}
                  className="w-full rounded-md border-[0.5px] border-border bg-background py-1.5 pl-7 pr-2 text-[12px] text-foreground placeholder:text-muted-foreground focus:border-foreground/30 focus:outline-none"
                />
              </div>
            ) : null}
            <div className="flex max-h-56 flex-col overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-2 py-2 text-[12px] text-muted-foreground">No matches.</p>
              ) : (
                filtered.map((source) => {
                  const active = selected.has(sourceKey(source));
                  return (
                    <button
                      key={sourceKey(source)}
                      type="button"
                      onClick={() => onToggle(source)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
                        active ? "bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      <span className="shrink-0">
                        {source.platform === "slack" ? (
                          <SlackLogoIcon size={14} aria-hidden />
                        ) : (
                          <WhatsappLogoIcon size={14} aria-hidden />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{source.label ?? source.targetId}</span>
                      {active ? <CheckCircleIcon size={13} weight="fill" aria-hidden /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function NumberField({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.trunc(next))));
        }}
        className="w-20 rounded-lg border-[0.5px] border-border bg-background px-3 py-2 text-[13px] text-foreground focus:border-foreground/30 focus:outline-none"
      />
    </label>
  );
}

export function TargetList({
  loading,
  empty,
  selectedId,
  options,
  onSelect,
}: {
  loading: boolean;
  empty: string;
  selectedId: string;
  options: Array<{ id: string; label: string; icon: React.ReactNode }>;
  onSelect: (id: string, label: string) => void;
}) {
  if (loading) return <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading...</p>;
  if (options.length === 0) return <p className="px-2 py-2 text-[12px] text-muted-foreground">{empty}</p>;
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border-[0.5px] border-border p-1">
      <div className="flex flex-col">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id, option.label)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
              selectedId === option.id
                ? "bg-emerald-500/10 text-foreground"
                : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            <span className="shrink-0">{option.icon}</span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {selectedId === option.id ? <CheckCircleIcon size={13} weight="fill" aria-hidden /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Persists a changed route into the agent's routes and recomputes the union of sources. */
export function saveRoutes(agentKey: string, routes: AgentRoute[], lookup: Map<string, AgentSourceConfig>) {
  return api.agents.updateConfig(agentKey, { sources: routesToSources(routes, lookup), routes });
}

export function InputIcon({ platform }: { platform: "slack" | "whatsapp" | null }) {
  if (platform === "whatsapp")
    return <WhatsappLogoIcon size={14} aria-hidden className="shrink-0 text-muted-foreground" />;
  return <SlackLogoIcon size={14} aria-hidden className="shrink-0 text-muted-foreground" />;
}
