import { QuietAddButton } from "@/components/quiet-add-button";
/**
 * The agents landing — the curated catalog of prebuilt agents. Most are a single
 * code-owned, opt-in job rendered as one row with an on/off switch. A
 * source-backed agent (the summariser) instead expands into one sub-row per
 * summariser it owns, each linking to its own config page, with a "New
 * summariser" action that opens the first-time-setup modal.
 */
import { type AgentRoute, type AgentSourceConfig, type AgentSummary, api } from "@/lib/api";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Switch } from "@sketch/ui/components/switch";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { SummariserSetupModal } from "./summariser-setup-modal";
import { InputIcon, deliversLabel, routeInput, sourceKey } from "./summariser-shared";

const AGENTS_LIST_KEY = ["agents", "list"];

export function AgentRoster() {
  const agentsQuery = useQuery({ queryKey: AGENTS_LIST_KEY, queryFn: () => api.agents.list() });
  const agents = agentsQuery.data?.agents ?? [];

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-medium text-foreground">Agents</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Prebuilt agents that run in the background on their own. Switch on what you need and tune it to your taste.
        </p>
      </header>

      {agentsQuery.isLoading ? (
        <p className="px-4 py-6 text-[12.5px] text-muted-foreground">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="px-4 py-6 text-[12.5px] text-muted-foreground">No agents available yet.</p>
      ) : (
        groupByCategory(agents).map((group) => (
          <div key={group.category} className="mb-6 last:mb-0">
            <GroupHeader title={group.category} note="switch on what you need" />
            <div className="flex flex-col gap-1">
              {group.items.map((agent) =>
                agent.sourceConfig ? (
                  <SummariserGroup key={agent.key} agent={agent} />
                ) : (
                  <BackgroundRow key={agent.key} agent={agent} />
                ),
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** Groups agents by their definition category, preserving first-seen order. */
function groupByCategory(agents: AgentSummary[]): { category: string; items: AgentSummary[] }[] {
  const groups: { category: string; items: AgentSummary[] }[] = [];
  for (const agent of agents) {
    let group = groups.find((g) => g.category === agent.category);
    if (!group) {
      group = { category: agent.category, items: [] };
      groups.push(group);
    }
    group.items.push(agent);
  }
  return groups;
}

function GroupHeader({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between border-b border-border/60 pb-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
      <span className="text-[11px] text-muted-foreground/70">{note}</span>
    </div>
  );
}

function useAgentInvalidate() {
  const queryClient = useQueryClient();
  return (key: string) => {
    void queryClient.invalidateQueries({ queryKey: AGENTS_LIST_KEY });
    void queryClient.invalidateQueries({ queryKey: ["agents", "detail", key] });
  };
}

function BackgroundRow({ agent }: { agent: AgentSummary }) {
  const invalidate = useAgentInvalidate();
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.agents.updateConfig(agent.key, { enabled }),
    onSuccess: (_data, enabled) => {
      invalidate(agent.key);
      toast.success(`${agent.title} ${enabled ? "switched on" : "switched off"}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to update agent"),
  });

  return (
    <div className="group flex items-center gap-3 rounded-xl px-4 py-3.5 transition-colors hover:bg-muted/40">
      <Link to="/agents/$agentKey" params={{ agentKey: agent.key }} className="min-w-0 flex-1">
        <span className="text-[14px] font-medium text-foreground">{agent.title}</span>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{agent.tagline}</p>
      </Link>
      <Switch
        checked={agent.enabled}
        disabled={toggleMutation.isPending}
        onCheckedChange={(checked) => toggleMutation.mutate(checked)}
        aria-label={`${agent.title} on`}
        className="data-[state=checked]:bg-emerald-500"
      />
      <Link to="/agents/$agentKey" params={{ agentKey: agent.key }} aria-label={`Open ${agent.title}`}>
        <CaretRightIcon
          size={14}
          aria-hidden
          className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
        />
      </Link>
    </div>
  );
}

function SummariserGroup({ agent }: { agent: AgentSummary }) {
  const invalidate = useAgentInvalidate();
  const [modalOpen, setModalOpen] = useState(false);
  const lookup = new Map<string, AgentSourceConfig>(agent.sources.map((source) => [sourceKey(source), source]));

  const toggleRoute = useMutation({
    mutationFn: (next: AgentRoute) =>
      api.agents.updateConfig(agent.key, { routes: agent.routes.map((r) => (r.id === next.id ? next : r)) }),
    onSuccess: () => invalidate(agent.key),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to update summariser"),
  });

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Link to="/agents/$agentKey" params={{ agentKey: agent.key }} className="min-w-0 flex-1">
          <span className="text-[14px] font-medium text-foreground">{agent.title}</span>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{agent.tagline}</p>
        </Link>
        <QuietAddButton onClick={() => setModalOpen(true)}>New</QuietAddButton>
      </div>

      <div className="ml-4 flex flex-col">
        {agent.routes.length === 0 ? (
          <p className="px-4 py-2 text-[12px] text-muted-foreground/80">
            No summarisers yet — add one to start delivering digests.
          </p>
        ) : (
          agent.routes.map((route) => {
            const input = routeInput(route, lookup);
            return (
              <div
                key={route.id}
                className={cn(
                  "group/sub flex items-center gap-3 rounded-lg px-4 py-2 transition-colors hover:bg-muted/40",
                  !route.enabled && "opacity-55",
                )}
              >
                <Link
                  to="/agents/$agentKey/summarisers/$routeId"
                  params={{ agentKey: agent.key, routeId: route.id }}
                  className="flex min-w-0 flex-1 items-center gap-2"
                >
                  <InputIcon platform={input.platform} />
                  <span className="truncate text-[12.5px] text-foreground">{input.label}</span>
                  {input.extra > 0 ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">+{input.extra}</span>
                  ) : null}
                  {route.owner ? (
                    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                      {route.owner.name}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">→ {deliversLabel(route)}</span>
                </Link>
                <Switch
                  checked={route.enabled}
                  disabled={toggleRoute.isPending}
                  onCheckedChange={(checked) => toggleRoute.mutate({ ...route, enabled: checked })}
                  aria-label={`${input.label} on`}
                  className="scale-90 data-[state=checked]:bg-emerald-500"
                />
                <CaretRightIcon
                  size={13}
                  aria-hidden
                  className="shrink-0 text-muted-foreground/20 transition-colors group-hover/sub:text-muted-foreground/60"
                />
              </div>
            );
          })
        )}
      </div>

      <SummariserSetupModal
        agentKey={agent.key}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => invalidate(agent.key)}
      />
    </div>
  );
}
