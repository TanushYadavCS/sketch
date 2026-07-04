/**
 * The agent detail lets users review generated output history and tune one
 * code-owned prebuilt agent through schedule, sources, focus, volume, delivery,
 * and per-section toggles.
 */
import {
  type AgentConfig,
  type AgentDeliveryConfig,
  type AgentDeliveryMention,
  type AgentDetailResponse,
  type AgentOutput,
  type AgentOutputsResponse,
  type AgentSourceConfig,
  api,
} from "@/lib/api";
import {
  ArrowLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  HashIcon,
  PencilSimpleIcon,
  PlusIcon,
  SlackLogoIcon,
  UserIcon,
  UsersThreeIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@sketch/ui/components/sheet";
import { Switch } from "@sketch/ui/components/switch";
import { TabButton } from "@sketch/ui/components/tab-button";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyCard, OutputView, RunButton, formatOutputDate } from "./agent-outputs-view";
import { SummariserSetupModal } from "./summariser-setup-modal";
import { InputIcon, deliversLabel, routeInput } from "./summariser-shared";

type Tab = "outputs" | "config";
type EditField = "schedule" | "focus" | "volume" | "delivery" | "sources" | null;

function detailKey(agentKey: string) {
  return ["agents", "detail", agentKey];
}

function outputsKey(agentKey: string) {
  return ["agents", "outputs", agentKey];
}

function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function deliverySummary(delivery: AgentDeliveryConfig | null): string {
  if (!delivery) return "Web only";
  const tagged = delivery.mentions?.length ? ` · ${delivery.mentions.length} tagged` : "";
  if (delivery.platform === "slack" && delivery.targetType === "channel")
    return `Slack ${delivery.label ?? delivery.targetId}${tagged}`;
  if (delivery.platform === "slack") return `Slack DM ${delivery.label ?? delivery.targetId}${tagged}`;
  return `WhatsApp ${delivery.label ?? delivery.targetId}${tagged}`;
}

export function AgentDetail({ agentKey }: { agentKey: string }) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: detailKey(agentKey),
    queryFn: () => api.agents.get(agentKey),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
  });
  const outputsQuery = useQuery({
    queryKey: outputsKey(agentKey),
    queryFn: () => api.agents.outputs(agentKey, { limit: 50 }),
    refetchInterval: () => (detailQuery.data?.running ? 3000 : false),
  });
  const [tab, setTab] = useState<Tab>("outputs");
  const [editing, setEditing] = useState<EditField>(null);
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: detailKey(agentKey) });
    void queryClient.invalidateQueries({ queryKey: outputsKey(agentKey) });
    void queryClient.invalidateQueries({ queryKey: ["agents", "list"] });
  };

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) => api.agents.updateConfig(agentKey, { enabled }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to update"),
  });
  const runMutation = useMutation({
    mutationFn: () => api.agents.run(agentKey),
    onSuccess: () => {
      invalidate();
      toast.success("Run started");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to start run"),
  });

  const outputs = outputsQuery.data?.outputs ?? [];
  useEffect(() => {
    if (!selectedOutputId && outputs.length > 0) setSelectedOutputId(outputs[0].id);
  }, [outputs, selectedOutputId]);

  const data = detailQuery.data;
  if (detailQuery.isLoading) {
    return <Shell>{null}</Shell>;
  }
  if (!data) {
    return (
      <Shell>
        <p className="mt-10 text-center text-[14px] text-muted-foreground">No such agent.</p>
      </Shell>
    );
  }

  const { agent } = data;
  const running = data.running || runMutation.isPending;
  const selectedOutput = outputs.find((output) => output.id === selectedOutputId) ?? outputs[0] ?? data.output;

  return (
    <Shell>
      <header className="mt-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-medium text-foreground">{agent.title}</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{agent.tagline}</p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-muted-foreground">
          <Switch
            checked={agent.enabled}
            disabled={enabledMutation.isPending}
            onCheckedChange={(checked) => enabledMutation.mutate(checked)}
            aria-label={`${agent.title} active`}
            className="data-[state=checked]:bg-emerald-500"
          />
          {agent.enabled ? "On" : "Off"}
        </span>
      </header>

      <div className="mt-6 flex items-center gap-6 border-b border-border">
        <TabButton label="Outputs" isActive={tab === "outputs"} onClick={() => setTab("outputs")} />
        <TabButton label="Config" isActive={tab === "config"} onClick={() => setTab("config")} />
      </div>

      <TabContentContainer className="pt-5">
        {tab === "outputs" ? (
          <OutputsTab
            data={data}
            outputsData={outputsQuery.data}
            outputsLoading={outputsQuery.isLoading}
            selectedOutput={selectedOutput}
            selectedOutputId={selectedOutput?.id ?? null}
            onSelectOutput={setSelectedOutputId}
            running={running}
            onRun={() => runMutation.mutate()}
            runPending={runMutation.isPending}
          />
        ) : (
          <ConfigTab agentKey={agentKey} agent={agent} onEdit={setEditing} onChanged={invalidate} />
        )}
      </TabContentContainer>

      <EditDrawer
        field={editing}
        agentKey={agentKey}
        agent={agent}
        onClose={() => setEditing(null)}
        onSaved={invalidate}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <Link
        to="/agents"
        className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon size={13} weight="bold" aria-hidden />
        Agents
      </Link>
      {children}
    </div>
  );
}

function OutputsTab({
  data,
  outputsData,
  outputsLoading,
  selectedOutput,
  selectedOutputId,
  onSelectOutput,
  running,
  onRun,
  runPending,
}: {
  data: AgentDetailResponse;
  outputsData: AgentOutputsResponse | undefined;
  outputsLoading: boolean;
  selectedOutput: AgentOutput | null;
  selectedOutputId: string | null;
  onSelectOutput: (id: string) => void;
  running: boolean;
  onRun: () => void;
  runPending: boolean;
}) {
  const outputs = outputsData?.outputs ?? [];
  const sectionTitles = Object.fromEntries(data.agent.sections.map((section) => [section.key, section.title]));
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          {selectedOutput
            ? `Generated ${formatOutputDate(selectedOutput.generatedAt ?? selectedOutput.outputDate)}`
            : "No output yet"}
        </span>
        <RunButton running={running} pending={runPending} onRun={onRun} />
      </div>

      {running && !selectedOutput ? (
        <EmptyCard>Generating…</EmptyCard>
      ) : outputsLoading && outputs.length === 0 ? (
        <EmptyCard>Loading…</EmptyCard>
      ) : !selectedOutput ? (
        <EmptyCard>Nothing yet. Run it now or wait for its next scheduled run.</EmptyCard>
      ) : (
        <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex flex-col gap-1">
            {outputs.map((output) => (
              <button
                key={output.id}
                type="button"
                onClick={() => onSelectOutput(output.id)}
                className={cn(
                  "rounded-lg px-3 py-2 text-left transition-colors",
                  selectedOutputId === output.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                <span className="block truncate text-[12.5px] font-medium">{output.sourceLabel ?? "Summary"}</span>
                <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[0.08em]">
                  {formatOutputDate(output.generatedAt ?? output.outputDate)}
                </span>
              </button>
            ))}
          </div>
          <OutputView output={selectedOutput} sectionTitles={sectionTitles} />
        </div>
      )}
    </div>
  );
}

function ConfigTab({
  agentKey,
  agent,
  onEdit,
  onChanged,
}: {
  agentKey: string;
  agent: AgentConfig;
  onEdit: (field: EditField) => void;
  onChanged: () => void;
}) {
  if (agent.sourceConfig) {
    return <SummariserIndex agentKey={agentKey} agent={agent} onChanged={onChanged} />;
  }
  return (
    <>
      <div className="rounded-xl border-[0.5px] border-border bg-card px-4">
        <Row label="What it does">
          <p className="text-[12.5px] leading-relaxed text-foreground/85">{agent.description}</p>
        </Row>
        <Row label="Runs on" onEdit={() => onEdit("schedule")}>
          <p className="text-[12.5px] text-foreground/85">
            Every day at {formatTime(agent.scheduleHour, agent.scheduleMinute)}
          </p>
        </Row>
        <Row label="Focus" onEdit={() => onEdit("focus")}>
          <p className="line-clamp-2 text-[12.5px] leading-relaxed text-foreground/85">
            {agent.focus ? agent.focus : <span className="text-muted-foreground">None — add what to emphasize.</span>}
          </p>
        </Row>
        <Row label="Volume" onEdit={() => onEdit("volume")}>
          <p className="text-[12.5px] text-foreground/85">Up to {agent.maxItemsPerSection} items per section</p>
        </Row>
        <Row label="Deliver to" onEdit={() => onEdit("delivery")}>
          <p className="text-[12.5px] text-foreground/85">{deliverySummary(agent.delivery)}</p>
        </Row>
      </div>

      <div className="mb-3 mt-7 flex items-baseline justify-between border-b border-border/60 pb-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Sections</span>
        <span className="text-[11px] text-muted-foreground/70">turn on only what you want</span>
      </div>
      <div className="flex flex-col gap-2">
        {agent.sections.map((section) => (
          <SectionToggleRow
            key={section.key}
            agentKey={agentKey}
            sectionKey={section.key}
            title={section.title}
            enabled={section.enabled}
            onChanged={onChanged}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Source-backed agents manage their summarisers as sub-rows in the roster and on
 * per-summariser config pages. The agent's Config tab is a lightweight index:
 * what it does, plus links into each summariser and a New-summariser modal.
 */
function SummariserIndex({
  agentKey,
  agent,
  onChanged,
}: {
  agentKey: string;
  agent: AgentConfig;
  onChanged: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const lookup = new Map(agent.sources.map((source) => [sourceKey(source), source] as const));

  return (
    <div className="space-y-6">
      <div className="rounded-lg border-[0.5px] border-border bg-card p-4 dark:bg-[#111110]">
        <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">What it does</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/85">{agent.description}</p>
      </div>

      <div className="overflow-hidden rounded-lg border-[0.5px] border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.07em] text-muted-foreground">Summarisers</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">{agent.routes.length}</span>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border-[0.5px] border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent dark:bg-[#111110] dark:hover:bg-[#1C1C1A]"
          >
            <PlusIcon size={12} weight="bold" aria-hidden />
            New summariser
          </button>
        </div>

        {agent.routes.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">
            No summarisers yet. Add one to start delivering digests.
          </p>
        ) : (
          <div className="flex flex-col">
            {agent.routes.map((route) => {
              const input = routeInput(route, lookup);
              return (
                <Link
                  key={route.id}
                  to="/agents/$agentKey/summarisers/$routeId"
                  params={{ agentKey, routeId: route.id }}
                  className={cn(
                    "group flex items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-secondary/50 dark:hover:bg-muted/30",
                    !route.enabled && "opacity-55",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <InputIcon platform={input.platform} />
                    <span className="truncate text-[12.5px] font-medium text-foreground">{input.label}</span>
                    {input.extra > 0 ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">+{input.extra}</span>
                    ) : null}
                  </span>
                  <span className="text-[12px] text-muted-foreground">{deliversLabel(route)}</span>
                  <span className="w-16 text-right text-[12px] tabular-nums text-muted-foreground">
                    {formatTime(
                      route.schedule?.hour ?? agent.scheduleHour,
                      route.schedule?.minute ?? agent.scheduleMinute,
                    )}
                  </span>
                  <CaretRightIcon
                    size={13}
                    aria-hidden
                    className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
                  />
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <SummariserSetupModal
        agentKey={agentKey}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={onChanged}
      />
    </div>
  );
}

function SectionToggleRow({
  agentKey,
  sectionKey,
  title,
  enabled,
  onChanged,
}: {
  agentKey: string;
  sectionKey: string;
  title: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (next: boolean) => api.agents.updateConfig(agentKey, { sections: { [sectionKey]: next } }),
    onSuccess: onChanged,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to update section"),
  });
  return (
    <div className="flex items-center gap-3 rounded-xl border-[0.5px] border-border bg-card px-4 py-3">
      <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground">{title}</p>
      <Switch
        checked={enabled}
        disabled={mutation.isPending}
        onCheckedChange={(checked) => mutation.mutate(checked)}
        aria-label={title}
        className="data-[state=checked]:bg-emerald-500"
      />
    </div>
  );
}

function Row({ label, children, onEdit }: { label: string; children: React.ReactNode; onEdit?: () => void }) {
  const className = "group flex w-full items-start gap-3 border-b border-border/50 py-3.5 text-left last:border-0";
  const inner = (
    <>
      <span className="mt-[1px] w-[88px] shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {onEdit ? (
        <PencilSimpleIcon
          size={13}
          weight="bold"
          aria-hidden
          className="mt-[1px] shrink-0 text-muted-foreground/30 transition-colors group-hover:text-foreground"
        />
      ) : null}
    </>
  );
  if (!onEdit) return <div className={className}>{inner}</div>;
  return (
    <button type="button" onClick={onEdit} className={className}>
      {inner}
    </button>
  );
}

const EDIT_META: Record<Exclude<EditField, null>, { title: string; hint: string }> = {
  schedule: { title: "Runs on", hint: "When the agent runs each day, in your timezone." },
  focus: { title: "Focus", hint: "Plain-language emphasis. Added as a hint — it never overrides what the agent does." },
  sources: { title: "Sources", hint: "Shared conversations this agent summarizes." },
  volume: { title: "Volume", hint: "How many items each section can hold." },
  delivery: { title: "Deliver to", hint: "Where completed outputs are sent after generation finishes." },
};

function EditDrawer({
  field,
  agentKey,
  agent,
  onClose,
  onSaved,
}: {
  field: EditField;
  agentKey: string;
  agent: AgentConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const meta = field ? EDIT_META[field] : null;
  const [hour, setHour] = useState(agent.scheduleHour);
  const [minute, setMinute] = useState(agent.scheduleMinute);
  const [focus, setFocus] = useState(agent.focus ?? "");
  const [sources, setSources] = useState<AgentSourceConfig[]>(agent.sources);
  const [volume, setVolume] = useState(agent.maxItemsPerSection);
  const [delivery, setDelivery] = useState<AgentDeliveryConfig | null>(agent.delivery);

  useEffect(() => {
    if (field) {
      setHour(agent.scheduleHour);
      setMinute(agent.scheduleMinute);
      setFocus(agent.focus ?? "");
      setSources(agent.sources);
      setVolume(agent.maxItemsPerSection);
      setDelivery(agent.delivery);
    }
  }, [
    field,
    agent.scheduleHour,
    agent.scheduleMinute,
    agent.focus,
    agent.sources,
    agent.maxItemsPerSection,
    agent.delivery,
  ]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (field === "schedule")
        return api.agents.updateConfig(agentKey, { scheduleHour: hour, scheduleMinute: minute });
      if (field === "focus") return api.agents.updateConfig(agentKey, { focus: focus.trim() ? focus.trim() : null });
      if (field === "sources") return api.agents.updateConfig(agentKey, { sources });
      if (field === "volume") return api.agents.updateConfig(agentKey, { maxItemsPerSection: volume });
      if (field === "delivery") return api.agents.updateConfig(agentKey, { delivery });
      return Promise.resolve({ agent });
    },
    onSuccess: () => {
      onSaved();
      toast.success("Saved");
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save"),
  });
  const saveDisabled =
    saveMutation.isPending || (field === "delivery" && delivery !== null && delivery.targetId.trim().length === 0);

  return (
    <Sheet open={field !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[460px]">
        <SheetHeader>
          <SheetTitle>{meta?.title}</SheetTitle>
          <SheetDescription>{meta?.hint}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 px-4 py-4">
          {field === "schedule" ? (
            <div className="flex items-center gap-2">
              <NumberField label="Hour" min={0} max={23} value={hour} onChange={setHour} />
              <span className="mt-5 text-muted-foreground">:</span>
              <NumberField label="Minute" min={0} max={59} value={minute} onChange={setMinute} />
              <span className="mt-5 ml-2 text-[12.5px] text-muted-foreground">{formatTime(hour, minute)}</span>
            </div>
          ) : field === "focus" ? (
            <div>
              <textarea
                rows={4}
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="e.g. prioritize enterprise accounts and anything blocking the launch"
                className="w-full resize-none rounded-lg border-[0.5px] border-border bg-background px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground/90 placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
                A hint the agent leans on. It never changes the sections, labels, or limits — those are fixed.
              </p>
            </div>
          ) : field === "volume" ? (
            <NumberField
              label="Items per section"
              min={agent.itemsPerSectionRange.min}
              max={agent.itemsPerSectionRange.max}
              value={volume}
              onChange={setVolume}
            />
          ) : field === "sources" && agent.sourceConfig ? (
            <SourceEditor agent={agent} value={sources} onChange={setSources} />
          ) : field === "delivery" ? (
            <DeliveryEditor value={delivery} sources={agent.sources} onChange={setDelivery} />
          ) : null}
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border-[0.5px] border-border px-4 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saveDisabled}
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <CheckCircleIcon size={13} weight="bold" aria-hidden />
            Save
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function NumberField({
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
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">{label}</span>
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

function sourceKey(source: AgentSourceConfig): string {
  return `${source.platform}:${source.targetType}:${source.targetId}`;
}

function mentionKey(mention: AgentDeliveryMention): string {
  return `${mention.platform}:${mention.targetId}`;
}

function sourceToDelivery(source: AgentSourceConfig): AgentDeliveryConfig {
  return {
    enabled: true,
    platform: source.platform,
    targetType: source.targetType,
    targetId: source.targetId,
    label: source.label,
  };
}

function SourceEditor({
  agent,
  value,
  onChange,
}: {
  agent: AgentConfig;
  value: AgentSourceConfig[];
  onChange: (value: AgentSourceConfig[]) => void;
}) {
  const slackChannels = useQuery({ queryKey: ["slack-channels"], queryFn: () => api.channels.listSlack() });
  const whatsappGroups = useQuery({ queryKey: ["whatsapp-groups"], queryFn: () => api.channels.listWhatsAppGroups() });
  const selected = new Set(value.map(sourceKey));
  const maxSources = agent.sourceConfig?.maxSources ?? 0;

  const toggle = (source: AgentSourceConfig) => {
    const key = sourceKey(source);
    if (selected.has(key)) {
      onChange(value.filter((item) => sourceKey(item) !== key));
      return;
    }
    if (value.length >= maxSources) return;
    onChange([...value, source]);
  };

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
  const availableCount =
    (agent.sourceConfig?.supportsSlackChannels ? slackOptions.length : 0) +
    (agent.sourceConfig?.supportsWhatsAppGroups ? whatsappOptions.length : 0);
  const sourcesLoading =
    (agent.sourceConfig?.supportsSlackChannels && slackChannels.isLoading) ||
    (agent.sourceConfig?.supportsWhatsAppGroups && whatsappGroups.isLoading);
  const countSummary = [
    `${value.length} selected`,
    sourcesLoading ? null : `${availableCount} available`,
    maxSources > 0 ? `limit ${maxSources}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-5">
      {agent.sourceConfig?.supportsSlackChannels ? (
        <SourceGroup
          title="Slack channels"
          loading={slackChannels.isLoading}
          empty="No Slack channels available."
          selected={selected}
          options={slackOptions}
          onToggle={toggle}
        />
      ) : null}
      {agent.sourceConfig?.supportsWhatsAppGroups ? (
        <SourceGroup
          title="WhatsApp groups"
          loading={whatsappGroups.isLoading}
          empty="No WhatsApp groups available."
          selected={selected}
          options={whatsappOptions}
          onToggle={toggle}
        />
      ) : null}
      <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">{countSummary}</p>
    </div>
  );
}

function SourceGroup({
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
  return (
    <div>
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">{title}</span>
      <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border-[0.5px] border-border p-1">
        {loading ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading...</p>
        ) : options.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">{empty}</p>
        ) : (
          <div className="flex flex-col">
            {options.map((source) => {
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
                      <HashIcon size={14} aria-hidden />
                    ) : (
                      <UsersThreeIcon size={14} aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{source.label ?? source.targetId}</span>
                  {active ? <CheckCircleIcon size={13} weight="fill" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DeliveryEditor({
  value,
  sources,
  onChange,
}: {
  value: AgentDeliveryConfig | null;
  sources: AgentSourceConfig[];
  onChange: (value: AgentDeliveryConfig | null) => void;
}) {
  const slackChannels = useQuery({ queryKey: ["slack-channels"], queryFn: () => api.channels.listSlack() });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.users.list() });
  const whatsappGroups = useQuery({ queryKey: ["whatsapp-groups"], queryFn: () => api.channels.listWhatsAppGroups() });
  const session = useQuery({ queryKey: ["auth", "session"], queryFn: () => api.auth.session() });

  const platform = value?.platform ?? "slack";
  const targetType = value?.targetType ?? (platform === "slack" ? "channel" : "group");
  const enabled = value !== null;
  const mentions = value?.mentions ?? [];

  const setEnabled = (next: boolean) => {
    if (!next) {
      onChange(null);
      return;
    }
    onChange({ enabled: true, platform: "slack", targetType: "channel", targetId: "", label: null });
  };

  const setPlatform = (next: "slack" | "whatsapp") => {
    if (!enabled) return;
    onChange({
      enabled: true,
      platform: next,
      targetType: next === "slack" ? "channel" : "group",
      targetId: "",
      label: null,
      mentions: [],
    });
  };

  const setTargetType = (next: "channel" | "dm" | "group") => {
    if (!enabled) return;
    onChange({ enabled: true, platform, targetType: next, targetId: "", label: null, mentions: [] });
  };

  const selectTarget = (targetId: string, label: string) => {
    if (!enabled) return;
    onChange({ enabled: true, platform, targetType, targetId, label, mentions: [] });
  };

  const toggleMention = (mention: AgentDeliveryMention) => {
    if (!value?.targetId) return;
    const key = mentionKey(mention);
    const selected = mentions.some((item) => mentionKey(item) === key);
    const next = selected ? mentions.filter((item) => mentionKey(item) !== key) : [...mentions, mention];
    onChange({ ...value, mentions: next });
  };

  const channelOptions = (slackChannels.data?.channels ?? []).filter((channel) => channel.isMember);
  const dmOptions = (users.data?.users ?? []).filter(
    (user) => user.id === session.data?.userId && user.type !== "agent" && user.slack_user_id,
  );
  const slackMentionOptions = (users.data?.users ?? [])
    .filter((user) => user.type !== "agent" && user.slack_user_id)
    .map(
      (user): AgentDeliveryMention => ({
        platform: "slack",
        targetId: user.slack_user_id ?? "",
        label: user.email ? `${user.name} <${user.email}>` : user.name,
      }),
    );
  const whatsappMentionOptions = (users.data?.users ?? [])
    .filter((user) => user.type !== "agent" && user.whatsapp_number)
    .map(
      (user): AgentDeliveryMention => ({
        platform: "whatsapp",
        targetId: user.whatsapp_number ?? "",
        label: user.name,
      }),
    );
  const groupOptions = whatsappGroups.data?.groups ?? [];
  const canPostToSource = sources.length === 1;
  const mentionOptions = platform === "slack" ? slackMentionOptions : whatsappMentionOptions;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-lg border-[0.5px] border-border px-3 py-2.5">
        <span className="text-[13px] font-medium text-foreground">Send completed outputs</span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Send completed outputs"
          className="data-[state=checked]:bg-emerald-500"
        />
      </div>

      {enabled ? (
        <>
          {canPostToSource ? (
            <button
              type="button"
              onClick={() => onChange(sourceToDelivery(sources[0]))}
              className="flex w-full items-center justify-between gap-3 rounded-lg border-[0.5px] border-border px-3 py-2.5 text-left text-[12.5px] text-foreground transition-colors hover:bg-muted/50"
            >
              <span>Post back to {sources[0].label ?? sources[0].targetId}</span>
              {value?.platform === sources[0].platform &&
              value.targetType === sources[0].targetType &&
              value.targetId === sources[0].targetId ? (
                <CheckCircleIcon size={13} weight="fill" aria-hidden />
              ) : null}
            </button>
          ) : null}

          <SegmentedControl
            label="Platform"
            options={[
              { value: "slack", label: "Slack", icon: <SlackLogoIcon size={14} aria-hidden /> },
              { value: "whatsapp", label: "WhatsApp", icon: <WhatsappLogoIcon size={14} aria-hidden /> },
            ]}
            value={platform}
            onChange={(next) => setPlatform(next as "slack" | "whatsapp")}
          />

          {platform === "slack" ? (
            <SegmentedControl
              label="Target"
              options={[
                { value: "channel", label: "Channel", icon: <HashIcon size={14} aria-hidden /> },
                { value: "dm", label: "DM", icon: <UserIcon size={14} aria-hidden /> },
              ]}
              value={targetType}
              onChange={(next) => setTargetType(next as "channel" | "dm")}
            />
          ) : null}

          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
              Destination
            </span>
            <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border-[0.5px] border-border p-1">
              {platform === "slack" && targetType === "channel" ? (
                <TargetList
                  loading={slackChannels.isLoading}
                  empty="No Slack channels available."
                  selectedId={value?.targetId ?? ""}
                  options={channelOptions.map((channel) => ({
                    id: channel.id,
                    label: `#${channel.name}`,
                    icon: <HashIcon size={14} aria-hidden />,
                  }))}
                  onSelect={selectTarget}
                />
              ) : platform === "slack" ? (
                <TargetList
                  loading={users.isLoading}
                  empty="No Slack DMs available."
                  selectedId={value?.targetId ?? ""}
                  options={dmOptions.map((user) => ({
                    id: user.slack_user_id ?? "",
                    label: user.email ? `${user.name} <${user.email}>` : user.name,
                    icon: <UserIcon size={14} aria-hidden />,
                  }))}
                  onSelect={selectTarget}
                />
              ) : (
                <TargetList
                  loading={whatsappGroups.isLoading}
                  empty="No WhatsApp groups available."
                  selectedId={value?.targetId ?? ""}
                  options={groupOptions.map((group) => ({
                    id: group.jid,
                    label: group.name,
                    icon: <UsersThreeIcon size={14} aria-hidden />,
                  }))}
                  onSelect={selectTarget}
                />
              )}
            </div>
          </div>

          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
              Notify people
            </span>
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border-[0.5px] border-border p-1">
              {!value?.targetId ? (
                <p className="px-2 py-2 text-[12px] text-muted-foreground">Choose a destination first.</p>
              ) : (
                <MentionList
                  loading={users.isLoading}
                  empty={platform === "slack" ? "No Slack people available." : "No WhatsApp people available."}
                  selected={new Set(mentions.map(mentionKey))}
                  options={mentionOptions}
                  onToggle={toggleMention}
                />
              )}
            </div>
          </div>
        </>
      ) : (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          The output will remain available here and will not be posted to a channel.
        </p>
      )}
    </div>
  );
}

function SegmentedControl({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string; icon: React.ReactNode }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">{label}</span>
      <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg border-[0.5px] border-border bg-muted/25 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors",
              value === option.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TargetList({
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
  onSelect: (targetId: string, label: string) => void;
}) {
  if (loading) return <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading...</p>;
  if (options.length === 0) return <p className="px-2 py-2 text-[12px] text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-col">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onSelect(option.id, option.label)}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
            selectedId === option.id ? "bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:bg-muted/60",
          )}
        >
          <span className="shrink-0">{option.icon}</span>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {selectedId === option.id ? <CheckCircleIcon size={13} weight="fill" aria-hidden /> : null}
        </button>
      ))}
    </div>
  );
}

function MentionList({
  loading,
  empty,
  selected,
  options,
  onToggle,
}: {
  loading: boolean;
  empty: string;
  selected: Set<string>;
  options: AgentDeliveryMention[];
  onToggle: (mention: AgentDeliveryMention) => void;
}) {
  if (loading) return <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading...</p>;
  if (options.length === 0) return <p className="px-2 py-2 text-[12px] text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-col">
      {options.map((option) => {
        const active = selected.has(mentionKey(option));
        return (
          <button
            key={mentionKey(option)}
            type="button"
            onClick={() => onToggle(option)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
              active ? "bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            <span className="shrink-0">
              <UserIcon size={14} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate">{option.label ?? option.targetId}</span>
            {active ? <CheckCircleIcon size={13} weight="fill" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}
