/**
 * "Project suggestions" — pending weekly-mint verdicts, rendered as the first
 * section of the Projects review band. Presentational: the band owns the
 * verdicts query (admin-gated there — every project-minting endpoint is
 * behind a blanket admin gate, so members must never trigger the fetch) and
 * passes rows in, which also lets verdict presence count toward the band's
 * render/early-return decision. Dismiss rejects inline without opening the
 * sheet; junk should never cost a click more than it has to.
 */
import { MintingVerdictRow } from "@/components/minting-verdict-row";
import { MintingVerdictSheet } from "@/components/minting-verdict-sheet";
import { type ProjectMintingVerdict, api } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export function ProjectSuggestionsSection({ verdicts }: { verdicts: ProjectMintingVerdict[] }) {
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const dismiss = useMutation({
    mutationFn: (verdictId: string) => api.projectMinting.reject(verdictId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-minting"] });
    },
  });

  if (verdicts.length === 0) return null;

  return (
    <section
      className="overflow-hidden border-b border-amber-300/40 dark:border-amber-700/30"
      data-testid="review-band-project-suggestions"
    >
      <div className="flex items-baseline justify-between border-b border-border bg-muted/30 px-3 py-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Project suggestions · {verdicts.length}
        </span>
      </div>
      <div className="divide-y divide-border/60">
        {verdicts.map((verdict) => (
          <MintingVerdictRow
            key={verdict.id}
            verdict={verdict}
            onOpen={() => setOpenId(verdict.id)}
            trailing={
              <button
                type="button"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(verdict.id)}
                className="shrink-0 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Dismiss
              </button>
            }
          />
        ))}
      </div>
      <MintingVerdictSheet variant="org" verdictId={openId} onClose={() => setOpenId(null)} onDecided={() => {}} />
    </section>
  );
}
