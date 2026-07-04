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
  type AgentSourceConfig,
  type AgentSourceKey,
  api,
} from "@/lib/api";
import { CheckCircleIcon, HashIcon, MagnifyingGlassIcon, UserIcon, UsersThreeIcon } from "@phosphor-icons/react";
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
  hour: number;
  minute: number;
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
  setHour: (v: number) => void;
  setMinute: (v: number) => void;
  setSection: (key: string, on: boolean) => void;
  setFocus: (v: string) => void;
  setVolume: (v: number) => void;
  build: (base: AgentRoute | null) => AgentRoute;
}

/** Local editable state for one summariser, seeded from an existing route or blank for a new one. */
export function useRouteDraft(agent: AgentConfig, route: AgentRoute | null): RouteDraftController {
  const maxSources = agent.sourceConfig?.maxSources ?? 0;
  const [sources, setSources] = useState<AgentSourceKey[]>(route?.sources ?? []);
  const [destKind, setDestKind] = useState<AgentRouteDestination["kind"]>(route?.destination.kind ?? "self");
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
  const [hour, setHour] = useState(route?.schedule?.hour ?? agent.scheduleHour);
  const [minute, setMinute] = useState(route?.schedule?.minute ?? agent.scheduleMinute);
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

  const isValid =
    sources.length > 0 &&
    !(destKind === "self" && sources.length !== 1) &&
    !(destKind === "member" && (!memberUserId || hasWhatsApp)) &&
    !(destKind === "channel" && !channelTarget);

  const build = (base: AgentRoute | null): AgentRoute => {
    const destination: AgentRouteDestination =
      destKind === "self"
        ? { kind: "self" }
        : destKind === "member" && memberUserId
          ? { kind: "member", platform: "slack", memberUserId }
          : destKind === "channel" && channelTarget
            ? channelDestination(channelTarget)
            : { kind: "off" };
    return {
      id: base?.id ?? crypto.randomUUID(),
      sources,
      focus: focus.trim() ? focus.trim() : null,
      sections,
      maxItemsPerSection: volume,
      schedule: { hour, minute },
      destination,
      enabled: base?.enabled ?? true,
    };
  };

  return {
    sources,
    destKind,
    memberUserId,
    channelTarget,
    hour,
    minute,
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
    setHour,
    setMinute,
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
  const dmAvailable = (agent.sourceConfig?.supportsSlackChannels ?? false) && !hasWhatsApp;

  const memberQuery = useQuery({
    queryKey: ["route-members", agentKey, controller.sources],
    queryFn: () => api.agents.routeMembers(agentKey, controller.sources),
    enabled: activeTab === "dm" && controller.sources.length > 0 && dmAvailable,
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
      ) : !dmAvailable ? (
        <p className="mt-3 px-1 py-2 text-[12px] text-muted-foreground">
          Member DM works with Slack sources only. Remove the WhatsApp source to DM a member.
        </p>
      ) : (
        <div className="mt-3">
          <TargetList
            loading={memberQuery.isLoading}
            empty="No member is in every selected source."
            selectedId={memberUserId ?? ""}
            options={(memberQuery.data?.members ?? []).map((member) => ({
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
                    <HashIcon size={14} aria-hidden />
                  ) : (
                    <UsersThreeIcon size={14} aria-hidden />
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

export function ScheduleField({ controller }: { controller: RouteDraftController }) {
  return (
    <div>
      <span className={LABEL}>Runs on</span>
      <div className="mt-2 flex items-center gap-2">
        <NumberField label="Hour" min={0} max={23} value={controller.hour} onChange={controller.setHour} />
        <span className="mt-5 text-muted-foreground">:</span>
        <NumberField label="Minute" min={0} max={59} value={controller.minute} onChange={controller.setMinute} />
        <span className="mt-5 ml-2 text-[12.5px] text-muted-foreground">
          {formatTime(controller.hour, controller.minute)}
        </span>
      </div>
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
    return <UsersThreeIcon size={14} aria-hidden className="shrink-0 text-muted-foreground" />;
  return <HashIcon size={14} aria-hidden className="shrink-0 text-muted-foreground" />;
}
