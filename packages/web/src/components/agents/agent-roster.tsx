/**
 * The agents landing — the curated catalog of prebuilt agents. Each is a single,
 * code-owned, opt-in job rendered as one row with an on/off switch and a
 * click-through to its detail + config. Users switch them on and tune them; they
 * cannot author new ones. Design ported from the `feat/demo-mask-pii` roster.
 */
import { type AgentSummary, api } from "@/lib/api";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Switch } from "@sketch/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

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
            <div className="flex flex-col">
              {group.items.map((agent) => (
                <BackgroundRow key={agent.key} agent={agent} />
              ))}
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

function GroupHeader({ title, note, className }: { title: string; note: string; className?: string }) {
  return (
    <div className={`mb-2 flex items-baseline justify-between border-b border-border/60 pb-2 ${className ?? ""}`}>
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
      <span className="text-[11px] text-muted-foreground/70">{note}</span>
    </div>
  );
}

function BackgroundRow({ agent }: { agent: AgentSummary }) {
  const queryClient = useQueryClient();
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.agents.updateConfig(agent.key, { enabled }),
    onSuccess: (_data, enabled) => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ["agents", "detail", agent.key] });
      toast.success(`${agent.title} ${enabled ? "switched on" : "switched off"}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update agent");
    },
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
