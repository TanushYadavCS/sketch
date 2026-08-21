/**
 * Run a pass on one company. This is the trigger the pipeline never had — until
 * now the only way to produce a verdict was a script in the repo.
 *
 * Scoped to one cluster per click on purpose. An unscoped pass calls a
 * reasoning model once per triggered cluster, which is real money on a button,
 * so the server takes a single `companyEntityId` and there is no "run all".
 *
 * Clusters come from stages 1–2 only, so listing is free and says exactly what
 * the model would be given: how many files, whether the recurrence trigger
 * fired, and which signals gathered the cluster.
 */
import { type ProjectMintingCluster, api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function MintingClusters() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [runId, setRunId] = useState<string | null>(null);

  const clustersQuery = useQuery({
    queryKey: ["project-minting", "clusters"],
    queryFn: () => api.projectMinting.listClusters(),
    retry: false,
  });

  /**
   * Stage 3 takes tens of seconds on a large cluster, so the run is polled
   * rather than awaited. Finishing refreshes the pending queue beside it.
   */
  const runQuery = useQuery({
    queryKey: ["project-minting", "pass", runId],
    queryFn: () => api.projectMinting.getPass(runId ?? ""),
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data?.run.status === "running" ? 2000 : false),
  });
  const run = runQuery.data?.run ?? null;
  const settled = run && run.status !== "running" ? run.id : null;

  /** Refresh the queue beside this once, when the run stops — not on every render while it polls. */
  useEffect(() => {
    if (!settled) return;
    queryClient.invalidateQueries({ queryKey: ["project-minting", "verdicts"] });
    queryClient.invalidateQueries({ queryKey: ["project-minting", "clusters"] });
  }, [settled, queryClient]);

  const start = useMutation({
    mutationFn: (companyEntityId: string) => api.projectMinting.startPass(companyEntityId),
    onSuccess: (data) => setRunId(data.run.id),
  });

  if (clustersQuery.isLoading) {
    return (
      <div className="mt-4 space-y-2">
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-11 rounded-md" />
        ))}
      </div>
    );
  }
  if (clustersQuery.isError) {
    return (
      <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
        Could not load clusters: {String(clustersQuery.error)}
      </p>
    );
  }

  const all = clustersQuery.data?.clusters ?? [];
  const passesEnabled = clustersQuery.data?.passesEnabled ?? false;
  const needle = filter.trim().toLowerCase();
  const matches = (needle ? all.filter((c) => c.companyName.toLowerCase().includes(needle)) : all).slice(0, 25);
  const busy = start.isPending || run?.status === "running";

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Run a pass · {all.length} clusters
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground">
          {all.filter((c) => c.triggered).length} triggered
        </span>
      </div>

      <p className="mb-2 text-[12px] text-muted-foreground">
        One company per run. Stage 3 calls a reasoning model, so this costs money and takes tens of seconds on a large
        cluster.
      </p>

      <Input
        value={filter}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFilter(e.target.value)}
        placeholder="Filter by company…"
        className="text-sm"
      />

      {run ? <RunBanner run={run} /> : null}
      {start.error ? <p className="mt-2 text-[12px] text-destructive">{String(start.error)}</p> : null}

      <div className="mt-2 divide-y divide-border rounded-md border border-border">
        {matches.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground">No clusters match.</p>
        ) : (
          matches.map((cluster) => (
            <ClusterRow
              key={cluster.companyEntityId}
              cluster={cluster}
              disabled={busy || !passesEnabled}
              onRun={() => start.mutate(cluster.companyEntityId)}
            />
          ))
        )}
      </div>
      {all.length > matches.length ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Showing {matches.length} of {all.length}. Filter to narrow.
        </p>
      ) : null}
    </section>
  );
}

function RunBanner({ run }: { run: NonNullable<Awaited<ReturnType<typeof api.projectMinting.getPass>>["run"]> }) {
  const name = run.snapshot?.companyName ?? "cluster";
  if (run.status === "running") {
    return (
      <p className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12.5px]">
        Running on <span className="font-medium text-foreground">{name}</span> — the verdict appears in the queue below
        when it finishes.
      </p>
    );
  }
  if (run.status === "failed") {
    return (
      <p className="mt-2 rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
        Pass on {name} failed: {run.errorMessage ?? "unknown error"}
      </p>
    );
  }
  const stored = run.snapshot?.verdictsStored ?? 0;
  return (
    <p className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12.5px]">
      Finished on <span className="font-medium text-foreground">{name}</span> — {stored} verdict
      {stored === 1 ? "" : "s"} stored.
    </p>
  );
}

function ClusterRow({
  cluster,
  disabled,
  onRun,
}: {
  cluster: ProjectMintingCluster;
  disabled: boolean;
  onRun: () => void;
}) {
  const detail = [
    cluster.shardNames.length > 1 ? `${cluster.shardNames.length} shards` : null,
    cluster.channels.length > 0 ? `#${cluster.channels[0]}` : null,
    cluster.signals.join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{cluster.triggered ? "T" : " "}</span>
      <span className="shrink-0 text-[13px] font-medium text-foreground">{cluster.companyName}</span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{detail}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{cluster.fileCount} files</span>
      {cluster.pendingVerdictId ? (
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">queued</span>
      ) : (
        <Button size="sm" variant="outline" className="shrink-0 text-xs" disabled={disabled} onClick={onRun}>
          Run
        </Button>
      )}
    </div>
  );
}
