/**
 * The agent detail — read and tune one prebuilt agent. Two tabs: **Latest** (the
 * most recent output) and **Config** (the calm ledger — schedule · focus · volume,
 * each editable in a drawer, then per-section toggles). Behavior itself is
 * code-owned, so "What it does" is read-only. Design ported from the
 * `feat/demo-mask-pii` agent detail + background config.
 */
import { type AgentConfig, type AgentDeliveryConfig, type AgentDetailResponse, type AgentOutput, api } from "@/lib/api";
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  HashIcon,
  PencilSimpleIcon,
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
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Tab = "latest" | "config";
type EditField = "schedule" | "focus" | "volume" | "delivery" | null;

function detailKey(agentKey: string) {
  return ["agents", "detail", agentKey];
}

function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function deliverySummary(delivery: AgentDeliveryConfig | null): string {
  if (!delivery) return "Web only";
  if (delivery.platform === "slack" && delivery.targetType === "channel")
    return `Slack ${delivery.label ?? delivery.targetId}`;
  if (delivery.platform === "slack") return `Slack DM ${delivery.label ?? delivery.targetId}`;
  return `WhatsApp ${delivery.label ?? delivery.targetId}`;
}

export function AgentDetail({ agentKey }: { agentKey: string }) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: detailKey(agentKey),
    queryFn: () => api.agents.get(agentKey),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
  });
  const [tab, setTab] = useState<Tab>("latest");
  const [editing, setEditing] = useState<EditField>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: detailKey(agentKey) });
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

  return (
    <Shell>
      <header className="mt-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[19px] font-semibold text-foreground">{agent.title}</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{agent.tagline}</p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-muted-foreground">
          <Switch
            checked={agent.enabled}
            disabled={enabledMutation.isPending}
            onCheckedChange={(checked) => enabledMutation.mutate(checked)}
            aria-label={`${agentKey} active`}
            className="data-[state=checked]:bg-emerald-500"
          />
          {agent.enabled ? "On" : "Off"}
        </span>
      </header>

      <div className="mt-6 flex items-center gap-1 border-b border-border/60">
        <TabButton active={tab === "latest"} onClick={() => setTab("latest")}>
          Latest
        </TabButton>
        <TabButton active={tab === "config"} onClick={() => setTab("config")}>
          Config
        </TabButton>
      </div>

      <div className="pt-5">
        {tab === "latest" ? (
          <LatestTab
            data={data}
            running={running}
            onRun={() => runMutation.mutate()}
            runPending={runMutation.isPending}
          />
        ) : (
          <ConfigTab agentKey={agentKey} agent={agent} onEdit={setEditing} onChanged={invalidate} />
        )}
      </div>

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

// --- Latest tab -------------------------------------------------------------

function LatestTab({
  data,
  running,
  onRun,
  runPending,
}: {
  data: AgentDetailResponse;
  running: boolean;
  onRun: () => void;
  runPending: boolean;
}) {
  const output = data.output;
  const sectionTitles = Object.fromEntries(data.agent.sections.map((section) => [section.key, section.title]));
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          {output ? `Generated ${formatDate(output.generatedAt ?? output.outputDate)}` : "No output yet"}
        </span>
        <RunButton running={running} pending={runPending} onRun={onRun} />
      </div>

      {running && !output ? (
        <EmptyCard>Generating…</EmptyCard>
      ) : !output ? (
        <EmptyCard>Nothing yet. Run it now or wait for its next scheduled run.</EmptyCard>
      ) : (
        <OutputView output={output} sectionTitles={sectionTitles} />
      )}
    </div>
  );
}

function OutputView({ output, sectionTitles }: { output: AgentOutput; sectionTitles: Record<string, string> }) {
  const sectionEntries = Object.entries(output.sections).filter(([, items]) => items.length > 0);
  return (
    <div className="flex flex-col gap-6">
      {output.masthead ? (
        <div className="rounded-xl border-[0.5px] border-border bg-gradient-to-b from-muted/50 to-card px-4 py-3.5">
          <p className="text-[14px] font-semibold text-foreground">{output.masthead.title}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{output.masthead.summary}</p>
        </div>
      ) : null}
      {sectionEntries.length === 0 ? (
        <EmptyCard>No items in this run.</EmptyCard>
      ) : (
        sectionEntries.map(([sectionKey, items]) => (
          <div key={sectionKey}>
            <div className="mb-2 border-b border-border/60 pb-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                {sectionTitles[sectionKey] ?? sectionKey}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {items.map((item) => (
                <div key={item.id} className="rounded-xl border-[0.5px] border-border bg-card px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[13px] font-medium text-foreground">{item.title}</span>
                    {item.label ? (
                      <span className="rounded-full bg-muted/60 px-1.5 py-[1px] font-mono text-[8.5px] uppercase tracking-[0.06em] text-muted-foreground">
                        {item.label.replaceAll("_", " ")}
                      </span>
                    ) : null}
                    {item.displayRef ? (
                      <span className="font-mono text-[10px] text-muted-foreground/70">{item.displayRef}</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{item.summary}</p>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function RunButton({ running, pending, onRun }: { running: boolean; pending: boolean; onRun: () => void }) {
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={running || pending}
      className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {running ? "Running…" : "Run now"}
    </button>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border py-10 text-center text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}

// --- Config tab -------------------------------------------------------------

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

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
        active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// --- Edit drawer ------------------------------------------------------------

const EDIT_META: Record<Exclude<EditField, null>, { title: string; hint: string }> = {
  schedule: { title: "Runs on", hint: "When the agent runs each day, in your timezone." },
  focus: { title: "Focus", hint: "Plain-language emphasis. Added as a hint — it never overrides what the agent does." },
  volume: { title: "Volume", hint: "How many items each section can hold." },
  delivery: { title: "Deliver to", hint: "Where scheduled runs send the saved brief after generation finishes." },
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
  const [volume, setVolume] = useState(agent.maxItemsPerSection);
  const [delivery, setDelivery] = useState<AgentDeliveryConfig | null>(agent.delivery);

  useEffect(() => {
    if (field) {
      setHour(agent.scheduleHour);
      setMinute(agent.scheduleMinute);
      setFocus(agent.focus ?? "");
      setVolume(agent.maxItemsPerSection);
      setDelivery(agent.delivery);
    }
  }, [field, agent.scheduleHour, agent.scheduleMinute, agent.focus, agent.maxItemsPerSection, agent.delivery]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (field === "schedule")
        return api.agents.updateConfig(agentKey, { scheduleHour: hour, scheduleMinute: minute });
      if (field === "focus") return api.agents.updateConfig(agentKey, { focus: focus.trim() ? focus.trim() : null });
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
          ) : field === "delivery" ? (
            <DeliveryEditor value={delivery} onChange={setDelivery} />
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

function DeliveryEditor({
  value,
  onChange,
}: {
  value: AgentDeliveryConfig | null;
  onChange: (value: AgentDeliveryConfig | null) => void;
}) {
  const slackChannels = useQuery({ queryKey: ["slack-channels"], queryFn: () => api.channels.listSlack() });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.users.list() });
  const whatsappGroups = useQuery({ queryKey: ["whatsapp-groups"], queryFn: () => api.channels.listWhatsAppGroups() });
  const session = useQuery({ queryKey: ["auth", "session"], queryFn: () => api.auth.session() });

  const platform = value?.platform ?? "slack";
  const targetType = value?.targetType ?? (platform === "slack" ? "channel" : "group");
  const enabled = value !== null;

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
    });
  };

  const setTargetType = (next: "channel" | "dm" | "group") => {
    if (!enabled) return;
    onChange({ enabled: true, platform, targetType: next, targetId: "", label: null });
  };

  const selectTarget = (targetId: string, label: string) => {
    if (!enabled) return;
    onChange({ enabled: true, platform, targetType, targetId, label });
  };

  const channelOptions = (slackChannels.data?.channels ?? []).filter((channel) => channel.isMember);
  const dmOptions = (users.data?.users ?? []).filter(
    (user) => user.id === session.data?.userId && user.type !== "agent" && user.slack_user_id,
  );
  const groupOptions = whatsappGroups.data?.groups ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-lg border-[0.5px] border-border px-3 py-2.5">
        <span className="text-[13px] font-medium text-foreground">Send scheduled briefs</span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Send scheduled briefs"
          className="data-[state=checked]:bg-emerald-500"
        />
      </div>

      {enabled ? (
        <>
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
        </>
      ) : (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          The brief will remain available on Home and will not be posted to a channel.
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

// --- helpers ----------------------------------------------------------------

function formatDate(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
