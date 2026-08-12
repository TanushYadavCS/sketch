/**
 * /dev-tools — internal pipeline debugging. Not linked from the nav and not
 * mounted unless the server ran with DEV_TOOLS_ENABLED, so a tenant never
 * reaches it.
 *
 * The surface is one file's journey through enrichment as eight stages: what
 * was sent to each model call, what came back, and what the code then did with
 * it — including the drops that leave no trace in the database.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { type DevTraceRunHeader, type UnifiedFile, api } from "@/lib/api";
import { type IntegrationType, getIntegration } from "@/lib/integrations";
import { FileDetailSheet } from "@/routes/files/file-detail-sheet";
import { WarningIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute, useDashboardAuth } from "../dashboard";
import { RunStatusBadge } from "./enrichment-trace";
import { TraceDialog } from "./trace-dialog";

export const devToolsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/dev-tools",
  component: DevToolsPage,
});

function DevToolsPage() {
  const auth = useDashboardAuth();
  const [traceFile, setTraceFile] = useState<{ id: string; name: string } | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const isAdmin = auth.role === "admin";

  /**
   * The probe is the gate. `/api/dev` is only mounted when the server ran with
   * DEV_TOOLS_ENABLED, so a failing list call is how this page learns the
   * surface is off — nothing about it is advertised anywhere a tenant can read.
   */
  const runsQuery = useQuery({
    queryKey: ["dev-tools", "runs"],
    queryFn: () => api.dev.enrichmentRuns(),
    enabled: isAdmin,
    retry: false,
    refetchInterval: 5000,
  });
  const mounted = isAdmin && !runsQuery.isError;

  function closeDialog() {
    setTraceFile(null);
    setOpenRunId(null);
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <h1 className="text-[22px] font-medium">Not available</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">This page does not exist for your account.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div>
        <h1 className="text-[22px] font-medium">Pipeline debug</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          One file through enrichment, stage by stage. Every model call, in and out. Internal only — not part of the
          product.
        </p>
      </div>

      {mounted ? (
        <>
          <div className="mt-5 flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
            <WarningIcon size={15} className="mt-0.5 shrink-0" />
            <span>
              This runs the real pipeline and re-runs stages the file has already been through, so it writes facts and
              can create entities. Prompts embed the file body, so this page shows raw customer content.
            </span>
          </div>

          <FilePicker onTrace={setTraceFile} />
          <PastRuns runs={runsQuery.data?.runs ?? []} onSelect={setOpenRunId} />
          <TraceDialog file={traceFile} existingRunId={openRunId} onOpenChange={(next) => !next && closeDialog()} />
        </>
      ) : (
        <p className="mt-5 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
          Dev tools are off on this deployment. Start the server with <code>DEV_TOOLS_ENABLED=true</code> to mount the
          debug routes.
        </p>
      )}
    </div>
  );
}

/**
 * Files filtered by connector, then by name. The source filter matters because
 * a pipeline bug is usually specific to one connector's shape of content, and
 * the flat recent-files list buries everything but the noisiest source.
 */
function FilePicker({ onTrace }: { onTrace: (file: { id: string; name: string }) => void }) {
  const [source, setSource] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [inspectFileId, setInspectFileId] = useState<string | null>(null);

  const countsQuery = useQuery({
    queryKey: ["dev-tools", "file-counts"],
    queryFn: () => api.integrations.fileCountsBySource(),
  });
  const filesQuery = useQuery({
    queryKey: ["dev-tools", "files", source],
    queryFn: () => api.integrations.allFiles({ limit: 200, ...(source ? { source } : {}) }),
  });

  const trimmed = filter.trim();
  const matches = (filesQuery.data?.files ?? [])
    .filter((file) => (trimmed ? matchesFile(file, trimmed) : true))
    .slice(0, 15);

  return (
    <section className="mt-7">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pick a file</h2>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <SourceChip label="All sources" active={source === null} onClick={() => setSource(null)} />
        {(countsQuery.data?.counts ?? []).map((entry) => (
          <SourceChip
            key={entry.source}
            label={sourceLabel(entry.source)}
            count={entry.count}
            source={entry.source}
            active={source === entry.source}
            onClick={() => setSource(entry.source)}
          />
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, or paste a file id"
          className="flex-1"
        />
        {looksLikeId(trimmed) && <Button onClick={() => onTrace({ id: trimmed, name: trimmed })}>Trace this id</Button>}
      </div>

      {filesQuery.isError && (
        <p className="mt-2 text-[13px] text-muted-foreground">Could not load files: {String(filesQuery.error)}</p>
      )}

      <div className="mt-2 divide-y divide-border rounded-md border border-border">
        {matches.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground">
            {filesQuery.isLoading ? "Loading files…" : "No files match."}
          </p>
        ) : (
          matches.map((file) => (
            <div key={file.id} className="flex items-center gap-2 px-3 py-2">
              <ConnectorLogo type={file.source as IntegrationType} size={14} className="shrink-0" />
              <button
                type="button"
                onClick={() => setInspectFileId(file.id)}
                className="min-w-0 flex-1 text-left"
                title="Open the file to check it is the right one"
              >
                <p className="truncate text-sm">{file.fileName}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {file.summaryStatus === "done" ? "enriched" : file.summaryStatus} · {file.id}
                </p>
              </button>
              <Button size="sm" variant="outline" onClick={() => onTrace({ id: file.id, name: file.fileName })}>
                Trace
              </Button>
            </div>
          ))
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Click a file name to open it and confirm you picked the right one. Trace runs the pipeline.
      </p>

      <FileDetailSheet fileId={inspectFileId} onClose={() => setInspectFileId(null)} />
    </section>
  );
}

function SourceChip({
  label,
  count,
  source,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  source?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${
        active ? "border-foreground/30 bg-muted font-medium" : "border-border text-muted-foreground"
      }`}
    >
      {source && <ConnectorLogo type={source as IntegrationType} size={12} />}
      {label}
      {count !== undefined && <span className="font-mono text-[10px] text-muted-foreground">{count}</span>}
    </button>
  );
}

function sourceLabel(source: string): string {
  return getIntegration(source as IntegrationType)?.name ?? source;
}

function matchesFile(file: UnifiedFile, needle: string) {
  const lower = needle.toLowerCase();
  return file.fileName.toLowerCase().includes(lower) || file.id.toLowerCase().includes(lower);
}

function looksLikeId(value: string) {
  return /^[0-9a-f-]{20,}$/i.test(value);
}

/**
 * Runs are held in memory and evicted, so this list is short by design and
 * empties on a server restart.
 */
function PastRuns({ runs, onSelect }: { runs: DevTraceRunHeader[]; onSelect: (runId: string) => void }) {
  if (runs.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</h2>
      <div className="divide-y divide-border rounded-md border border-border">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => onSelect(run.id)}
            className="flex w-full items-center gap-3 px-3 py-2 text-left"
          >
            <RunStatusBadge status={run.status} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{run.fileName}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {run.stepCount} steps · {run.startedAt.slice(11, 19)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
