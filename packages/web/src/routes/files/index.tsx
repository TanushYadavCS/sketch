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
import { GearIcon, SparkleIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "../dashboard";
import { ConnectorPicker } from "./connector-picker";
import { SearchSettingsSheet } from "./enrichment-controls";
import { EntityExplorer } from "./entity-explorer";
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

type FilesTab = "files" | "entities";

function FilesPage() {
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<FilesTab>("files");
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
  const [showSearchSettings, setShowSearchSettings] = useState(false);
  const [managingConnector, setManagingConnector] = useState<{
    definition: IntegrationDefinition;
    connector: ConnectorConfig;
  } | null>(null);
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("oauth");
    const connectorId = params.get("connectorId");

    if (!oauthStatus || connectors.length === 0) return;

    window.history.replaceState({}, "", window.location.pathname);

    if (oauthStatus === "success" && connectorId) {
      const connector = connectors.find((c) => c.id === connectorId);
      if (connector) {
        const def = getIntegration(connector.connectorType as IntegrationType);
        if (def) {
          toast.success("Google account connected — now select which drives or folders to sync.");
          setManagingConnector({ definition: def, connector });
          return;
        }
      }
      toast.success("Google Drive connected successfully.");
    } else if (oauthStatus === "error") {
      const reason = params.get("reason") ?? "unknown";
      const messages: Record<string, string> = {
        denied: "Google authorization was denied.",
        no_refresh_token:
          "No refresh token received — try revoking app access in Google Account settings and reconnecting.",
        token_exchange: "Failed to exchange authorization code for tokens.",
        not_configured: "Google OAuth is not configured.",
        internal: "An internal error occurred during authorization.",
      };
      toast.error(messages[reason] ?? `OAuth error: ${reason}`);
    }
  }, [connectors]);

  const serverSource = sourceFilter && sourceFilter !== "local" ? sourceFilter : undefined;

  const {
    data: filesData,
    isLoading: isLoadingFiles,
    isFetching: isFetchingFiles,
  } = useQuery({
    queryKey: ["all-files", pageSize, serverSource],
    queryFn: () => api.integrations.allFiles({ limit: pageSize, offset: 0, source: serverSource }),
    enabled: !!connectorsData,
    refetchInterval: 30000,
  });

  const allFiles: UnifiedFile[] = filesData?.files ?? [];
  const totalFiles = filesData?.total ?? 0;
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

  const filteredFiles = useMemo(() => {
    if (isInSearchMode) return allFiles;

    let result = allFiles;

    if (sourceFilter === "local") {
      result = result.filter((f) => f.source === "local");
    }
    if (typeFilter) {
      result = result.filter((f) => f.contentCategory === typeFilter);
    }
    if (statusFilter === "enriched") {
      result = result.filter((f) => f.hasSummary);
    } else if (statusFilter === "raw") {
      result = result.filter((f) => !f.hasSummary);
    }
    if (accessFilter) {
      result = result.filter((f) => f.accessScope === accessFilter);
    }

    return result;
  }, [allFiles, isInSearchMode, sourceFilter, typeFilter, statusFilter, accessFilter]);

  const enrichedCount = allFiles.filter((f) => f.hasSummary).length;
  const localFileCount = allFiles.filter((f) => f.source === "local").length;
  const hasAnyFilter = !!(sourceFilter || typeFilter || statusFilter || accessFilter || search.trim());
  const hasClientOnlyFilter = !!(
    typeFilter ||
    statusFilter ||
    accessFilter ||
    search.trim() ||
    sourceFilter === "local"
  );

  const handleConnected = () => {
    queryClient.invalidateQueries({ queryKey: ["integrations"] });
    queryClient.invalidateQueries({ queryKey: ["all-files"] });
  };

  const isLoading = isLoadingConnectors || isLoadingFiles;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Files</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your team's indexed knowledge base</p>
        </div>
        <div className="flex items-center gap-3">
          {!isLoadingConnectors && totalFiles > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {totalFiles.toLocaleString()} file{totalFiles !== 1 ? "s" : ""}
              </span>
              {enrichedCount > 0 && (
                <>
                  <span className="text-border">|</span>
                  <span className="flex items-center gap-1">
                    <SparkleIcon size={12} weight="fill" className="text-primary" />
                    {enrichedCount} enriched
                  </span>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowSearchSettings(true)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Search & enrichment settings"
          >
            <GearIcon size={16} />
          </button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="mt-4 flex gap-1 border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab("files")}
          className={`px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === "files"
              ? "border-b-2 border-foreground text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          All Files
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("entities")}
          className={`px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === "entities"
              ? "border-b-2 border-foreground text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Entity Explorer
        </button>
      </div>

      {activeTab === "entities" ? (
        <EntityExplorer />
      ) : (
        <>
          <ConnectorPicker
            connectors={connectors}
            totalFiles={totalFiles}
            localFileCount={localFileCount}
            sourceFilter={sourceFilter}
            onSourceFilterChange={setSourceFilter}
            onConnected={handleConnected}
            onManageConnector={(def, connector) => setManagingConnector({ definition: def, connector })}
            forcedConnectIntegration={reconnectTarget}
            onForcedConnectDone={() => setReconnectTarget(null)}
          />

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
              onView={setViewingFile}
              onLoadMore={loadMore}
            />
          </div>
        </>
      )}

      <ManageConnectorDialog
        definition={managingConnector?.definition ?? null}
        connector={managingConnector?.connector ?? null}
        open={!!managingConnector}
        onOpenChange={(open) => !open && setManagingConnector(null)}
        onDisconnected={handleConnected}
        onReconnect={(def) => {
          setManagingConnector(null);
          queryClient.invalidateQueries({ queryKey: ["integrations"] });
          setReconnectTarget(def);
        }}
      />

      <FileDetailSheet fileId={viewingFile} onClose={() => setViewingFile(null)} />

      <SearchSettingsSheet open={showSearchSettings} onOpenChange={setShowSearchSettings} />
    </div>
  );
}
