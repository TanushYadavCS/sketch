/**
 * The pending project-minting queue. Rows state the disagreement — what the
 * model nominated against what the registry declared — because a row where
 * those agree is usually a formality and one where they differ is the reason
 * to open it.
 *
 * Order comes from the server (`pendingSortKey`: flagged last, then confidence,
 * then age); this list does not re-sort. Nothing fills the queue over HTTP yet,
 * so the empty state carries the command that does.
 */
import { MintingVerdictRow } from "@/components/minting-verdict-row";
import { MintingVerdictSheet } from "@/components/minting-verdict-sheet";
import { type ProjectMintingAcceptance, api } from "@/lib/api";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MintingClusters } from "./minting-clusters";

export function MintingQueue() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [lastAccept, setLastAccept] = useState<ProjectMintingAcceptance | null>(null);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["project-minting", "verdicts"],
    queryFn: () => api.projectMinting.listVerdicts(),
    retry: false,
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-12 rounded-md" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
        Could not load verdicts: {String(error)}
      </p>
    );
  }

  const verdicts = data?.verdicts ?? [];

  return (
    <>
      <MintingClusters />
      <section className="mt-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pending verdicts · {verdicts.length}
        </h2>

        <UnresolvedAnchorNotice acceptance={lastAccept} onDismiss={() => setLastAccept(null)} />

        {verdicts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">Nothing waiting.</p>
            <p className="mt-1.5 text-[12px] text-muted-foreground">Run a pass on a company above to fill this.</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {verdicts.map((verdict) => (
              <MintingVerdictRow key={verdict.id} verdict={verdict} onOpen={() => setOpenId(verdict.id)} />
            ))}
          </div>
        )}

        <MintingVerdictSheet
          verdictId={openId}
          onClose={() => setOpenId(null)}
          onDecided={(accepted) => {
            setLastAccept(accepted);
            void refetch();
          }}
        />
      </section>
    </>
  );
}

/**
 * A minted project whose evidence was thinner than the verdict claimed. The
 * accept went through on the anchors that resolved, so this is a note about
 * what to go and check, not an error.
 */
function UnresolvedAnchorNotice({
  acceptance,
  onDismiss,
}: {
  acceptance: ProjectMintingAcceptance | null;
  onDismiss: () => void;
}) {
  const unresolved = acceptance?.unresolvedAnchors ?? [];
  if (unresolved.length === 0) return null;

  return (
    <div className="mb-2 rounded-md border border-amber-400/70 bg-amber-50 px-3 py-2 dark:bg-amber-950/30">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12.5px] text-amber-900 dark:text-amber-200">
          Accepted, but {unresolved.length} anchor{unresolved.length === 1 ? "" : "s"} matched nothing — usually the
          model paraphrasing a title family. Those files attached to nothing.
        </p>
        <button type="button" onClick={onDismiss} className="shrink-0 text-[11px] text-amber-900/70 underline">
          dismiss
        </button>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {unresolved.map((anchor) => (
          <li key={anchor} className="font-mono text-[11px] text-amber-900/80 dark:text-amber-200/80">
            {anchor}
          </li>
        ))}
      </ul>
    </div>
  );
}
