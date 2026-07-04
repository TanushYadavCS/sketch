/**
 * First-time setup for a new summariser. A single modal captures everything —
 * inputs, destination, schedule, sections, focus, and volume — then appends the
 * route to the agent and closes. Editing an existing summariser happens on its
 * own config page, not here.
 */
import { type AgentConfig, api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DestinationField,
  FocusField,
  ScheduleField,
  SectionsField,
  SourcesField,
  VolumeField,
  saveRoutes,
  useRouteDraft,
  useSourceOptions,
} from "./summariser-shared";

export function SummariserSetupModal({
  agentKey,
  open,
  onClose,
  onCreated,
}: {
  agentKey: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const configQuery = useQuery({
    queryKey: ["agents", "detail", agentKey],
    queryFn: () => api.agents.get(agentKey),
    enabled: open,
  });
  const agent = configQuery.data?.agent ?? null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>New summariser</DialogTitle>
          <DialogDescription>
            Pick the conversations to summarise, where the summary goes, and when it runs.
          </DialogDescription>
        </DialogHeader>
        {agent ? (
          <SetupBody agentKey={agentKey} agent={agent} onClose={onClose} onCreated={onCreated} />
        ) : (
          <p className="px-1 py-10 text-center text-[13px] text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SetupBody({
  agentKey,
  agent,
  onClose,
  onCreated,
}: {
  agentKey: string;
  agent: AgentConfig;
  onClose: () => void;
  onCreated: () => void;
}) {
  const controller = useRouteDraft(agent, null);
  const { lookup } = useSourceOptions(agent);

  const create = useMutation({
    mutationFn: () => saveRoutes(agentKey, [...agent.routes, controller.build(null)], lookup),
    onSuccess: () => {
      onCreated();
      toast.success("Summariser created");
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to create"),
  });

  return (
    <>
      <div className="flex-1 space-y-6 overflow-y-auto px-1 py-4">
        <SourcesField agent={agent} controller={controller} />
        <DestinationField agent={agent} agentKey={agentKey} controller={controller} />
        <ScheduleField controller={controller} />
        <SectionsField agent={agent} controller={controller} />
        <FocusField controller={controller} />
        <VolumeField agent={agent} controller={controller} />
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={!controller.isValid || create.isPending} onClick={() => create.mutate()}>
          Create summariser
        </Button>
      </DialogFooter>
    </>
  );
}
