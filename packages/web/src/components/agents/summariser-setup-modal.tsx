/**
 * First-time setup for a new summariser, as a short multi-step wizard: choose
 * inputs, then delivery, then schedule + content. Creating the first summariser
 * also switches the agent on. Editing an existing summariser happens on its own
 * config page, not here.
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
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  DestinationField,
  FocusField,
  ScheduleField,
  SectionsField,
  SourcesField,
  VolumeField,
  routesToSources,
  useRouteDraft,
  useSourceOptions,
} from "./summariser-shared";

const STEPS = [
  { title: "Inputs", hint: "Pick the conversations to summarise." },
  { title: "Delivery", hint: "Choose where the summary goes." },
  { title: "Schedule & content", hint: "Set when it runs and what it includes." },
];

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
          <DialogDescription>Set up a new summariser in three quick steps.</DialogDescription>
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
  const [step, setStep] = useState(0);
  const controller = useRouteDraft(agent, null);
  const { lookup } = useSourceOptions(agent);

  const create = useMutation({
    mutationFn: () => {
      const next = controller.build(null);
      const routes = [...agent.routes, next];
      return api.agents.updateConfig(agentKey, { enabled: true, sources: routesToSources(routes, lookup), routes });
    },
    onSuccess: () => {
      onCreated();
      toast.success("Summariser created");
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to create"),
  });

  const inputsValid = controller.sources.length > 0;
  const deliveryValid =
    !(controller.destKind === "self" && controller.sources.length !== 1) &&
    !(controller.destKind === "member" && (!controller.memberUserId || controller.hasWhatsApp));
  const canAdvance = step === 0 ? inputsValid : step === 1 ? deliveryValid : controller.isValid;
  const isLast = step === STEPS.length - 1;

  return (
    <>
      <Stepper step={step} />
      <p className="px-1 pt-3 text-[12px] text-muted-foreground">{STEPS[step].hint}</p>
      <div className="flex-1 overflow-y-auto px-1 py-4">
        {step === 0 ? (
          <SourcesField agent={agent} controller={controller} />
        ) : step === 1 ? (
          <DestinationField agent={agent} agentKey={agentKey} controller={controller} />
        ) : (
          <div className="space-y-6">
            <ScheduleField controller={controller} />
            <SectionsField agent={agent} controller={controller} />
            <FocusField controller={controller} />
            <VolumeField agent={agent} controller={controller} />
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>
          {step === 0 ? "Cancel" : "Back"}
        </Button>
        {isLast ? (
          <Button size="sm" disabled={!controller.isValid || create.isPending} onClick={() => create.mutate()}>
            Create summariser
          </Button>
        ) : (
          <Button size="sm" disabled={!canAdvance} onClick={() => setStep(step + 1)}>
            Next
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-1">
      {STEPS.map((s, i) => (
        <div key={s.title} className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium transition-colors",
              i < step
                ? "bg-emerald-500 text-white"
                : i === step
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {i + 1}
          </span>
          <span className={cn("text-[11.5px]", i === step ? "font-medium text-foreground" : "text-muted-foreground")}>
            {s.title}
          </span>
          {i < STEPS.length - 1 ? <span className="h-px w-4 bg-border" /> : null}
        </div>
      ))}
    </div>
  );
}
