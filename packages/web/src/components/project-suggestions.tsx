/**
 * "Project suggestions" — pending weekly-mint verdicts surfaced in the Your
 * Org review tab. Admin-only: every project-minting endpoint is behind a
 * blanket admin gate (accepting writes an org-wide company declaration), so
 * callers must not render this for members — the query here assumes it is
 * only mounted for admins. Dismiss rejects inline without opening the sheet;
 * junk should never cost a click more than it has to.
 */
import { MintingVerdictRow } from "@/components/minting-verdict-row";
import { MintingVerdictSheet } from "@/components/minting-verdict-sheet";
import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export function ProjectSuggestionsSection() {
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["project-minting", "verdicts"],
    queryFn: () => api.projectMinting.listVerdicts(),
    retry: false,
    refetchInterval: 30000,
  });
  const dismiss = useMutation({
    mutationFn: (verdictId: string) => api.projectMinting.reject(verdictId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-minting"] });
    },
  });

  const verdicts = data?.verdicts ?? [];
  if (isLoading || verdicts.length === 0) return null;

  return (
    <section
      className="mb-6 overflow-hidden rounded-xl border border-border"
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
