/**
 * MintTasksDialog — runs task extraction against one file and shows both halves of the
 * run: the context the server handed the model, and the tasks that came back.
 *
 * The context half is the point. A bad task list is usually a bad context list, and the
 * two are indistinguishable from the output alone — so every block states the rule that
 * selected it and the count it matched before any cap.
 */
import {
  type MintContextBlock,
  type MintSimilarFile,
  type MintTasksResult,
  type MintedTaskCandidate,
  api,
} from "@/lib/api";
import { CaretRightIcon, SparkleIcon, SpinnerGapIcon, WarningIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export function MintTasksDialog({
  fileId,
  fileName,
  open,
  onOpenChange,
}: {
  fileId: string;
  fileName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [result, setResult] = useState<MintTasksResult | null>(null);

  const mintMutation = useMutation({
    mutationFn: () => api.integrations.mintTasks(fileId),
    onSuccess: (data) => setResult(data),
    onError: (err: Error) => toast.error(err.message),
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      setResult(null);
      mintMutation.reset();
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Mint tasks</DialogTitle>
          <DialogDescription>
            Runs extraction against <span className="font-medium text-foreground">{fileName}</span> and shows what the
            model was given alongside what it returned.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <MintResult result={result} />
        ) : (
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Nothing has run yet. Extraction writes real tasks, visible only to you.
            </p>
            <Button onClick={() => mintMutation.mutate()} disabled={mintMutation.isPending} className="gap-1.5">
              {mintMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Extracting...
                </>
              ) : (
                <>
                  <SparkleIcon size={14} />
                  Run extraction
                </>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MintResult({ result }: { result: MintTasksResult }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary" className="font-mono text-[11px]">
          {result.model}
        </Badge>
        <span>{result.contentLength.toLocaleString()} chars</span>
        <span aria-hidden>·</span>
        <span>
          {result.candidates.length} extracted, {result.written} written
        </span>
      </div>

      {result.truncated && (
        <div className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <WarningIcon size={14} className="mt-0.5 shrink-0" />
          <span>
            The file was cut to fit the model window. Anything after {result.contentLength.toLocaleString()} characters
            was never seen, so missing tasks near the end are a context problem, not a model one.
          </span>
        </div>
      )}

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Context sent</h3>
        <div className="space-y-1.5">
          {result.context.map((block) => (
            <ContextBlockRow key={block.key} block={block} />
          ))}
          {result.similarFiles && result.similarFiles.length > 0 && (
            <ContextBlockRow block={similarFilesBlock(result.similarFiles)} />
          )}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Tasks extracted ({result.candidates.length})
        </h3>
        {result.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The model returned nothing. Check the context above before changing the prompt.
          </p>
        ) : (
          <div className="space-y-2">
            {result.candidates.map((candidate) => (
              <CandidateRow key={candidate.taskId ?? candidate.title} candidate={candidate} />
            ))}
          </div>
        )}
      </section>

      {result.dumpDir && <p className="font-mono text-[11px] text-muted-foreground">Raw call: {result.dumpDir}</p>}
    </div>
  );
}

/**
 * The neighbourhood is not sent to the model, but it decides which existing tasks are.
 * Rendering it through the same row keeps one collapsible implementation.
 */
function similarFilesBlock(files: MintSimilarFile[]): MintContextBlock {
  return {
    key: "similar_files",
    label: "Nearest files",
    selection: "Not sent to the model — these decide which existing tasks it sees.",
    total: files.length,
    items: files.map((file) => `${file.similarity.toFixed(3)}  ${file.fileName}`),
  };
}

function ContextBlockRow({ block }: { block: MintContextBlock }) {
  const [expanded, setExpanded] = useState(false);
  const empty = block.items.length === 0;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => !empty && setExpanded((v) => !v)}
        disabled={empty}
        className="flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
      >
        <CaretRightIcon
          size={12}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""} ${
            empty ? "opacity-0" : ""
          }`}
        />
        <span className="text-sm font-medium">{block.label}</span>
        <span className={`text-xs ${empty ? "text-muted-foreground" : ""}`}>
          {block.truncated ? `${block.items.length} of ${block.total}` : block.total}
        </span>
        {block.via === "tool" && (
          <Badge variant="outline" className="text-[10px]">
            fetched by model
          </Badge>
        )}
        <span className="ml-auto truncate text-xs text-muted-foreground">{block.selection}</span>
      </button>

      {expanded && (
        <ul className="border-t border-border px-3 py-2 space-y-1">
          {block.items.map((item) => (
            <li key={item} className="text-xs text-muted-foreground break-words">
              {item}
            </li>
          ))}
          {block.truncated && (
            <li className="text-xs italic text-muted-foreground">
              {block.total - block.items.length} more matched the rule but were not sent.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: MintedTaskCandidate }) {
  const ownerLabel = candidate.owner?.name ?? candidate.owner?.email ?? null;

  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="text-sm font-medium flex-1">{candidate.title}</span>
        {!candidate.taskId && (
          <Badge variant="outline" className="text-[10px] shrink-0">
            not written
          </Badge>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{ownerLabel ?? "no owner"}</span>
        {candidate.dueDate && <span>due {candidate.dueDate}</span>}
        <span>{candidate.projectName ?? "no project"}</span>
        {!candidate.hasOwnerVerbObject && <span className="italic">owner/verb/object not all present</span>}
      </div>

      {candidate.sourceExcerpt && (
        <p className="mt-1.5 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          {candidate.sourceExcerpt}
        </p>
      )}
    </div>
  );
}
