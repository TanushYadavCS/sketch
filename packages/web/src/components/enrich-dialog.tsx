import { api } from "@/lib/api";
import { SparkleIcon, SpinnerGapIcon } from "@phosphor-icons/react";
/**
 * AI Enrichment dialog — select files → provide instruction → trigger enrichment.
 *
 * Level 2 indexing: LLM-powered summaries + context notes, shaped by
 * an admin-provided instruction. One-time, explicit, opt-in activity.
 */
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Textarea } from "@sketch/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

interface EnrichDialogProps {
  connectorId: string;
  fileIds: string[];
  fileCount: number;
  integrationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnriched: () => void;
}

const INSTRUCTION_EXAMPLES = [
  "These are product PRDs — use as reference for roadmap discussions.",
  "Engineering design docs — summarize key decisions and trade-offs.",
  "Meeting notes from the leadership team — extract action items and decisions.",
  "Customer support knowledge base — focus on troubleshooting steps.",
];

export function EnrichDialog({
  connectorId,
  fileIds,
  fileCount,
  integrationName,
  open,
  onOpenChange,
  onEnriched,
}: EnrichDialogProps) {
  const [instruction, setInstruction] = useState("");

  const enrichMutation = useMutation({
    mutationFn: () =>
      api.integrations.enrich(connectorId, {
        fileIds,
        instruction: instruction.trim(),
      }),
    onSuccess: () => {
      toast.success(`Enrichment started for ${fileCount} file${fileCount === 1 ? "" : "s"}.`);
      setInstruction("");
      onOpenChange(false);
      onEnriched();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to start enrichment.");
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setInstruction("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparkleIcon size={18} weight="fill" className="text-primary" />
            AI Enrichment
          </DialogTitle>
          <DialogDescription>
            Generate AI-powered summaries and context notes for {fileCount} selected file
            {fileCount === 1 ? "" : "s"} from {integrationName}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground">What happens</p>
            <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
              <li>• Each file is sent to the LLM for summarization</li>
              <li>• A one-paragraph summary + context note is generated</li>
              <li>• Your instruction shapes how the LLM interprets the files</li>
              <li>• Uses your configured LLM API key</li>
            </ul>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="enrich-instruction" className="text-xs font-medium">
              Instruction{" "}
              <span className="font-normal text-muted-foreground">(optional — helps the LLM understand context)</span>
            </label>
            <Textarea
              id="enrich-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g., These are product PRDs — summarize key decisions and use as reference for roadmap discussions."
              disabled={enrichMutation.isPending}
              className="min-h-20 text-sm"
            />
            <div className="flex flex-wrap gap-1.5">
              {INSTRUCTION_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInstruction(example)}
                  className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {example.slice(0, 40)}…
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={enrichMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => enrichMutation.mutate()} disabled={enrichMutation.isPending}>
            {enrichMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <SparkleIcon size={14} weight="fill" />
                Enrich {fileCount} file{fileCount === 1 ? "" : "s"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
