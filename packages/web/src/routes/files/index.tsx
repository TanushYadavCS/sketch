/**
 * Files page — unified content library across all connected sources.
 *
 * Layout (top to bottom):
 * 1. Header — title + aggregate stats
 * 2. Source pills — thin horizontal chips (filter by click, "+" to connect, "Browse all" for full catalog)
 * 3. Toolbar — search + type/status filter dropdowns inline on one row
 * 4. File table — infinite list with enrichment, detail sheet
 *
 * State ownership: all filter/pagination state lives here and is passed down as props.
 * Data fetching lives here; child components receive data, not query keys.
 */
import type { ConnectorConfig } from "@/lib/api";
import { api } from "@/lib/api";
import type { SearchResult, UnifiedFile } from "@/lib/api";
import type { IntegrationDefinition, IntegrationType } from "@/lib/integrations";
import { getIntegration } from "@/lib/integrations";
import { SparkleIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "../dashboard";
import { ConnectorPicker } from "./connector-picker";
import { FileDetailSheet } from "./file-detail-sheet";
import { FileList } from "./file-list";
import { ManageConnectorDialog } from "./manage-connector-dialog";
import { SearchBar } from "./search-bar";

export const filesRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/files",
  component: FilesPage,
});

const PAGE_SIZE = 50;

type ManagingConnectorState = {
  definition: IntegrationDefinition;
  connector: ConnectorConfig;
};

export function getLiveManagingConnector(
  managingConnector: ManagingConnectorState | null,
  connectors: ConnectorConfig[],
): ConnectorConfig | null {
  if (!managingConnector) return null;
  return connectors.find((connector) => connector.id === managingConnector.connector.id) ?? managingConnector.connector;
}

export function syncingConnectorIdsWithoutProgress(
  connectors: ConnectorConfig[],
  activeProgressConnectorIds: Set<string>,
): string[] {
  return connectors
    .filter((connector) => connector.syncStatus === "syncing" && !activeProgressConnectorIds.has(connector.id))
    .map((connector) => connector.id);
}

export function FilesPage() {
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilterRaw] = useState<string | null>(null);
  const setSourceFilter = useCallback((value: string | null) => {
    setSourceFilterRaw(value);
    setPageSize(PAGE_SIZE);
  }, []);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [accessFilter, setAccessFilter] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [managingConnector, setManagingConnector] = useState<ManagingConnectorState | null>(null);
  /** Set when the user triggers "Update credentials" from ManageConnectorDialog — passed to ConnectorPicker to open its connect dialog. */
  const [reconnectTarget, setReconnectTarget] = useState<IntegrationDefinition | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const { data: connectorsData, isLoading: isLoadingConnectors } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.integrations.list(),
    refetchInterval: 30000,
  });

  const connectors = connectorsData?.connectors ?? [];
  const teamMemberCount = connectorsData?.teamMemberCount ?? 0;
  const connectorMemberCounts = connectorsData?.connectorMemberCounts ?? {};
  const liveManagingConnector = getLiveManagingConnector(managingConnector, connectors);
  const hasSyncingConnectors = connectors.some((connector) => connector.syncStatus === "syncing");

  // Viewer-aware file count per source. Connector-row counts under-count for
  // members who have file-access via meetings someone else's connector synced;
  // this aggregates from indexed_files so chips agree with the file list.
  const { data: sourceCountsData } = useQuery({
    queryKey: ["file-counts-by-source"],
    queryFn: () => api.integrations.fileCountsBySource(),
    refetchInterval: 30000,
  });
  const sourceCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of sourceCountsData?.counts ?? []) map.set(r.source, r.count);
    return map;
  }, [sourceCountsData]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("oauth");
    const connectorId = params.get("connectorId");
    const connectorParam = params.get("connector");
    const isMicrosoftFlow = connectorParam === "teams" || connectorParam === "outlook";

    if (!oauthStatus) return;
    if (oauthStatus !== "admin_consent_granted" && connectors.length === 0) return;

    window.history.replaceState({}, "", window.location.pathname);

    if (oauthStatus === "admin_consent_granted") {
      const name = connectorParam === "outlook" ? "Outlook" : "Microsoft Teams";
      toast.success(`Admin consent granted — teammates in your organization can now connect ${name}.`);
      return;
    }

    if (oauthStatus === "success" && connectorId) {
      const connector = connectors.find((c) => c.id === connectorId);
      const def = connector ? getIntegration(connector.connectorType as IntegrationType) : undefined;
      if (connector && def) {
        if (connector.connectorType === "gmail") {
          toast.success("Gmail connected — importing your recent mail now.");
        } else if (def.scopeType === "none") {
          toast.success(`${def.name} connected — syncing automatically.`);
        } else {
          toast.success(`${def.name} connected — now select what to sync.`);
          setManagingConnector({ definition: def, connector });
        }
        return;
      }
      toast.success("Connected successfully.");
    } else if (oauthStatus === "error") {
      const reason = params.get("reason") ?? "unknown";

      // already_connected: the user already has a Google Drive row. Surface the existing
      // connector so they can rotate/manage instead of re-authorizing into an orphan row.
      if (reason === "already_connected" && connectorId) {
        const connector = connectors.find((c) => c.id === connectorId);
        if (connector) {
          const def = getIntegration(connector.connectorType as IntegrationType);
          if (def) {
            toast.info(`You already have ${def.name} connected. Manage it here.`, {
              action: {
                label: "Manage",
                onClick: () => setManagingConnector({ definition: def, connector }),
              },
            });
            return;
          }
        }
        toast.info("You already have this connected. Open Files → Connections to manage it.");
        return;
      }

      if (reason === "admin_consent_required") {
        toast.error(
          "Your Microsoft admin must approve Sketch for this organization before you can connect. Ask an admin to grant consent, then try again.",
          {
            action: {
              label: "Grant admin consent",
              onClick: () => window.open(api.microsoftOAuth.adminConsentUrl(connectorParam ?? "teams"), "_self"),
            },
          },
        );
        return;
      }

      const provider = isMicrosoftFlow ? "Microsoft" : "Google";
      const messages: Record<string, string> = {
        denied: `${provider} authorization was denied.`,
        no_refresh_token: isMicrosoftFlow
          ? "No refresh token received — disconnect Sketch in your Microsoft account and reconnect."
          : "No refresh token received — try revoking app access in Google Account settings and reconnecting.",
        token_exchange: "Failed to exchange authorization code for tokens.",
        not_configured: `${provider} OAuth is not configured.`,
        internal: "An internal error occurred during authorization.",
      };
      toast.error(messages[reason] ?? `OAuth error: ${reason}`);
    }
  }, [connectors]);

  const serverSource = sourceFilter && sourceFilter !== "local" ? sourceFilter : undefined;
  const serverCategory = typeFilter || undefined;
  const serverStatus = statusFilter || undefined;
  const serverAccess = accessFilter || undefined;

  const {
    data: filesData,
    isLoading: isLoadingFiles,
    isFetching: isFetchingFiles,
  } = useQuery({
    queryKey: ["all-files", pageSize, serverSource, serverCategory, serverStatus, serverAccess],
    queryFn: () =>
      api.integrations.allFiles({
        limit: pageSize,
        offset: 0,
        source: serverSource,
        category: serverCategory,
        status: serverStatus,
        access: serverAccess,
      }),
    enabled: !!connectorsData,
    refetchInterval: 30000,
  });

  const allFiles: UnifiedFile[] = filesData?.files ?? [];
  const totalFiles = filesData?.total ?? 0;
  // Global count of enriched files under the current filters — the badge
  // used to derive this from the page slice (`allFiles.filter(f =>
  // f.hasSummary).length`), which underreported once the slice didn't
  // contain every enriched file. Backend now returns the filtered global.
  const enrichedTotal = filesData?.enrichedTotal ?? 0;
  const hasMore = filesData?.hasMore ?? false;

  const { data: searchData, isFetching: isSearching } = useQuery({
    queryKey: ["hybrid-search", debouncedSearch, serverSource],
    queryFn: () => api.integrations.search({ query: debouncedSearch, source: serverSource, limit: 20 }),
    enabled: debouncedSearch.length > 0,
    staleTime: 30000,
  });

  const searchResults: SearchResult[] = searchData?.results ?? [];
  const isInSearchMode = debouncedSearch.length > 0;

  const loadMore = useCallback(() => {
    setPageSize((prev) => prev + PAGE_SIZE);
  }, []);

  // Filtering is now server-side — allFiles already contains filtered results
  const filteredFiles = allFiles;

  const localFileCount = allFiles.filter((f) => f.source === "local").length;
  const hasAnyFilter = !!(sourceFilter || typeFilter || statusFilter || accessFilter || search.trim());
  const hasClientOnlyFilter = !!(
    typeFilter ||
    statusFilter ||
    accessFilter ||
    search.trim() ||
    sourceFilter === "local"
  );

  const refreshFilesData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["integrations"] });
    queryClient.invalidateQueries({ queryKey: ["file-counts-by-source"] });
    queryClient.invalidateQueries({ queryKey: ["all-files"] });
    queryClient.invalidateQueries({ queryKey: ["hybrid-search"] });
    queryClient.invalidateQueries({ queryKey: ["sync-progress"] });
  }, [queryClient]);

  const handleConnected = useCallback(() => {
    refreshFilesData();
  }, [refreshFilesData]);

  const handleDisconnected = useCallback(
    (connector: ConnectorConfig) => {
      if (sourceFilter === connector.connectorType) setSourceFilter(null);
      refreshFilesData();
    },
    [refreshFilesData, setSourceFilter, sourceFilter],
  );

  const isLoading = isLoadingConnectors || isLoadingFiles;

  const { data: progressData } = useQuery({
    queryKey: ["sync-progress"],
    queryFn: () => api.integrations.progress(),
    refetchInterval: hasSyncingConnectors ? 2000 : 10000,
  });

  const pendingEnrichment = progressData?.pendingEnrichment ?? 0;
  const enrichmentStats = progressData?.enrichmentStats;
  const enrichmentActive = progressData?.enrichmentActive ?? false;
  const handledCompletedSyncIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!progressData) return;

    const activeIds = new Set(progressData.active.map((progress) => progress.connectorId));
    const syncingIds = connectors
      .filter((connector) => connector.syncStatus === "syncing")
      .map((connector) => connector.id);

    if (syncingIds.length === 0) {
      handledCompletedSyncIdsRef.current.clear();
      return;
    }

    for (const id of syncingIds) {
      if (activeIds.has(id)) handledCompletedSyncIdsRef.current.delete(id);
    }

    const completedIds = syncingConnectorIdsWithoutProgress(connectors, activeIds).filter(
      (id) => !handledCompletedSyncIdsRef.current.has(id),
    );
    if (completedIds.length === 0) return;

    for (const id of completedIds) handledCompletedSyncIdsRef.current.add(id);
    refreshFilesData();
  }, [connectors, progressData, refreshFilesData]);

  const enrichMutation = useMutation({
    mutationFn: () => api.settings.runEnrichment(),
    onSuccess: () => {
      toast.success("Enrichment started — files will be processed in the background.");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-medium text-foreground">Files</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Your team's indexed knowledge base</p>
        </div>
        <div className="flex items-center gap-3">
          {!isLoadingConnectors && totalFiles > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {totalFiles.toLocaleString()} file{totalFiles !== 1 ? "s" : ""}
              </span>
              {enrichedTotal > 0 && (
                <>
                  <span className="text-border">|</span>
                  <span className="flex items-center gap-1">
                    <SparkleIcon size={12} weight="fill" className="text-primary" />
                    {enrichedTotal} enriched
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4">
        <ConnectorPicker
          connectors={connectors}
          teamMemberCount={teamMemberCount}
          connectorMemberCounts={connectorMemberCounts}
          sourceCounts={sourceCounts}
          totalFiles={totalFiles}
          localFileCount={localFileCount}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          onConnected={handleConnected}
          onManageConnector={(def, connector) => setManagingConnector({ definition: def, connector })}
          forcedConnectIntegration={reconnectTarget}
          onForcedConnectDone={() => setReconnectTarget(null)}
        />

        {totalFiles > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
            <div className="flex items-center gap-4 text-muted-foreground">
              <span>
                <SparkleIcon size={12} weight="fill" className="mr-1 inline text-primary" />
                {enrichmentStats
                  ? `${enrichmentStats.total - pendingEnrichment}/${enrichmentStats.total} indexed`
                  : pendingEnrichment > 0
                    ? `${pendingEnrichment} file${pendingEnrichment !== 1 ? "s" : ""} need to be indexed`
                    : "All files indexed"}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-xs"
              onClick={() => enrichMutation.mutate()}
              disabled={enrichMutation.isPending || enrichmentActive}
            >
              {(enrichMutation.isPending || enrichmentActive) && <SpinnerGapIcon size={12} className="animate-spin" />}
              {enrichmentActive ? "Indexing..." : "Enrich now"}
            </Button>
          </div>
        )}

        <SearchBar
          search={search}
          onSearchChange={setSearch}
          typeFilter={typeFilter}
          accessFilter={accessFilter}
          statusFilter={statusFilter}
          onTypeChange={setTypeFilter}
          onAccessChange={setAccessFilter}
          onStatusChange={setStatusFilter}
        />

        <div className="mt-4">
          <FileList
            isLoading={isLoading}
            isSearching={isSearching}
            isInSearchMode={isInSearchMode}
            isFetchingFiles={isFetchingFiles}
            filteredFiles={filteredFiles}
            searchResults={searchResults}
            debouncedSearch={debouncedSearch}
            hasAnyFilter={hasAnyFilter}
            hasMore={hasMore}
            hasClientOnlyFilter={hasClientOnlyFilter}
            allFilesCount={allFiles.length}
            totalFiles={totalFiles}
            onView={(id) => {
              const result = searchResults.find((r) => r.id === id);
              setViewingFile(result?.hitFileId ?? id);
            }}
            onLoadMore={loadMore}
          />
        </div>
      </div>

      <ManageConnectorDialog
        definition={managingConnector?.definition ?? null}
        connector={liveManagingConnector}
        open={!!managingConnector}
        onOpenChange={(open) => !open && setManagingConnector(null)}
        onDisconnected={handleDisconnected}
        onReconnect={(def) => {
          if (liveManagingConnector && sourceFilter === liveManagingConnector.connectorType) {
            setSourceFilter(null);
          }
          setManagingConnector(null);
          refreshFilesData();
          setReconnectTarget(def);
        }}
      />

      <FileDetailSheet fileId={viewingFile} connectors={connectors} onClose={() => setViewingFile(null)} />
    </div>
  );
}
