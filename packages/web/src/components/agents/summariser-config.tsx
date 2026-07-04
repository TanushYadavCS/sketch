/**
 * Per-summariser config page. One summariser (an AgentRoute) shown as the rich
 * row layout — Input, Runs on, Focus, Volume, Delivers to — plus inline section
 * toggles. Each row opens a focused side drawer that edits just that field of
 * the route; sections toggle in place.
 */
import { type AgentConfig, type AgentRoute, api } from "@/lib/api";
import { ArrowLeftIcon, CheckCircleIcon, PencilSimpleIcon } from "@phosphor-icons/react";
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
import { useState } from "react";
import { toast } from "sonner";
import {
  DestinationField,
  FocusField,
  InputIcon,
  ScheduleField,
  SourcesField,
  VolumeField,
  deliversLabel,
  formatTime,
  routeInput,
  saveRoutes,
  useRouteDraft,
  useSourceOptions,
} from "./summariser-shared";

type RouteField = "sources" | "schedule" | "focus" | "volume" | "delivery" | null;

const FIELD_META: Record<Exclude<RouteField, null>, { title: string; hint: string }> = {
  sources: { title: "Input", hint: "The conversations this summariser reads. Two or more combine into one summary." },
  schedule: { title: "Runs on", hint: "When this summariser runs each day, in your timezone." },
  focus: {
    title: "Focus",
    hint: "Plain-language emphasis for this summariser. A hint — it never overrides the sections.",
  },
  volume: { title: "Volume", hint: "How many items each section can hold." },
  delivery: { title: "Delivers to", hint: "Where this summary goes once it is generated." },
};

export function SummariserConfigPage({ agentKey, routeId }: { agentKey: string; routeId: string }) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({ queryKey: ["agents", "detail", agentKey], queryFn: () => api.agents.get(agentKey) });
  const [editing, setEditing] = useState<RouteField>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["agents", "detail", agentKey] });
    void queryClient.invalidateQueries({ queryKey: ["agents", "list"] });
  };

  const agent = detailQuery.data?.agent ?? null;
  const route = agent?.routes.find((r) => r.id === routeId) ?? null;

  if (detailQuery.isLoading) return <Shell>{null}</Shell>;
  if (!agent || !route) {
    return (
      <Shell>
        <p className="mt-10 text-center text-[14px] text-muted-foreground">No such summariser.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <SummariserBody agentKey={agentKey} agent={agent} route={route} onEdit={setEditing} onChanged={invalidate} />
      {editing ? (
        <RouteFieldDrawer
          key={editing}
          field={editing}
          agentKey={agentKey}
          agent={agent}
          route={route}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      ) : null}
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

function SummariserBody({
  agentKey,
  agent,
  route,
  onEdit,
  onChanged,
}: {
  agentKey: string;
  agent: AgentConfig;
  route: AgentRoute;
  onEdit: (field: RouteField) => void;
  onChanged: () => void;
}) {
  const { lookup } = useSourceOptions(agent);
  const input = routeInput(route, lookup);

  const save = useMutation({
    mutationFn: (next: AgentRoute) =>
      saveRoutes(
        agentKey,
        agent.routes.map((r) => (r.id === route.id ? next : r)),
        lookup,
      ),
    onSuccess: onChanged,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to update"),
  });

  return (
    <>
      <header className="mt-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <InputIcon platform={input.platform} />
            <h1 className="truncate text-[22px] font-medium text-foreground">{input.label}</h1>
            {input.extra > 0 ? (
              <span className="shrink-0 text-[13px] text-muted-foreground">+{input.extra}</span>
            ) : null}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Summariser · delivers {deliversLabel(route).toLowerCase()}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-muted-foreground">
          <Switch
            checked={route.enabled}
            disabled={save.isPending}
            onCheckedChange={(enabled) => save.mutate({ ...route, enabled })}
            aria-label="Summariser active"
            className="data-[state=checked]:bg-emerald-500"
          />
          {route.enabled ? "On" : "Off"}
        </span>
      </header>

      <div className="mt-6 rounded-xl border-[0.5px] border-border bg-card px-4">
        <Row label="Input" onEdit={() => onEdit("sources")}>
          <span className="flex items-center gap-1.5 text-[12.5px] text-foreground/85">
            {input.label}
            {input.extra > 0 ? <span className="text-muted-foreground">+{input.extra} more</span> : null}
          </span>
        </Row>
        <Row label="Runs on" onEdit={() => onEdit("schedule")}>
          <p className="text-[12.5px] text-foreground/85">
            Every day at{" "}
            {formatTime(route.schedule?.hour ?? agent.scheduleHour, route.schedule?.minute ?? agent.scheduleMinute)}
          </p>
        </Row>
        <Row label="Focus" onEdit={() => onEdit("focus")}>
          <p className="line-clamp-2 text-[12.5px] leading-relaxed text-foreground/85">
            {route.focus ? route.focus : <span className="text-muted-foreground">None — add what to emphasize.</span>}
          </p>
        </Row>
        <Row label="Volume" onEdit={() => onEdit("volume")}>
          <p className="text-[12.5px] text-foreground/85">
            Up to {route.maxItemsPerSection ?? agent.maxItemsPerSection} items per section
          </p>
        </Row>
        <Row label="Delivers to" onEdit={() => onEdit("delivery")}>
          <p className="text-[12.5px] text-foreground/85">{deliversLabel(route)}</p>
        </Row>
      </div>

      <div className="mb-3 mt-7 flex items-baseline justify-between border-b border-border/60 pb-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Sections</span>
        <span className="text-[11px] text-muted-foreground/70">turn on only what you want</span>
      </div>
      <div className="flex flex-col gap-2">
        {agent.sections.map((section) => {
          const on = route.sections?.[section.key] ?? section.enabled;
          return (
            <div
              key={section.key}
              className="flex items-center gap-3 rounded-xl border-[0.5px] border-border bg-card px-4 py-3"
            >
              <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground">{section.title}</p>
              <Switch
                checked={on}
                disabled={save.isPending}
                onCheckedChange={(next) => {
                  const sections: Record<string, boolean> = {};
                  for (const s of agent.sections) sections[s.key] = route.sections?.[s.key] ?? s.enabled;
                  sections[section.key] = next;
                  save.mutate({ ...route, sections });
                }}
                aria-label={section.title}
                className="data-[state=checked]:bg-emerald-500"
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

function Row({ label, children, onEdit }: { label: string; children: React.ReactNode; onEdit: () => void }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="group flex w-full items-start gap-3 border-b border-border/50 py-3.5 text-left last:border-0"
    >
      <span className="mt-[1px] w-[88px] shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      <PencilSimpleIcon
        size={13}
        weight="bold"
        aria-hidden
        className="mt-[1px] shrink-0 text-muted-foreground/30 transition-colors group-hover:text-foreground"
      />
    </button>
  );
}

function RouteFieldDrawer({
  field,
  agentKey,
  agent,
  route,
  onClose,
  onSaved,
}: {
  field: Exclude<RouteField, null>;
  agentKey: string;
  agent: AgentConfig;
  route: AgentRoute;
  onClose: () => void;
  onSaved: () => void;
}) {
  const controller = useRouteDraft(agent, route);
  const { lookup } = useSourceOptions(agent);
  const meta = FIELD_META[field];

  const save = useMutation({
    mutationFn: () =>
      saveRoutes(
        agentKey,
        agent.routes.map((r) => (r.id === route.id ? controller.build(route) : r)),
        lookup,
      ),
    onSuccess: () => {
      onSaved();
      toast.success("Saved");
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save"),
  });

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>{meta.title}</SheetTitle>
          <SheetDescription>{meta.hint}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 px-4 py-4">
          {field === "sources" ? (
            <SourcesField agent={agent} controller={controller} />
          ) : field === "schedule" ? (
            <ScheduleField controller={controller} />
          ) : field === "focus" ? (
            <FocusField controller={controller} />
          ) : field === "volume" ? (
            <VolumeField agent={agent} controller={controller} />
          ) : (
            <DestinationField agent={agent} agentKey={agentKey} controller={controller} />
          )}
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
            onClick={() => save.mutate()}
            disabled={save.isPending || !controller.isValid}
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
