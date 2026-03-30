/**
 * FileList — file table with two rendering modes:
 * 1. Browsing mode: full file list with source/type/access/status/date columns.
 * 2. Search mode: ranked search results with score and similarity columns.
 *
 * All data is passed in as props; this component owns no fetch state.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import type { SearchResult, UnifiedFile } from "@/lib/api";
import { type IntegrationType, getIntegration } from "@/lib/integrations";
import {
  ArrowSquareOutIcon,
  FileTextIcon,
  GlobeIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  SparkleIcon,
  SpinnerGapIcon,
  TableIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Skeleton } from "@sketch/ui/components/skeleton";

/** Relative time formatter — shared with FileDetailSheet via this module. */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function FileList({
  isLoading,
  isSearching,
  isInSearchMode,
  isFetchingFiles,
  filteredFiles,
  searchResults,
  debouncedSearch,
  hasAnyFilter,
  hasMore,
  hasClientOnlyFilter,
  allFilesCount,
  totalFiles,
  onView,
  onLoadMore,
}: {
  isLoading: boolean;
  isSearching: boolean;
  isInSearchMode: boolean;
  isFetchingFiles: boolean;
  filteredFiles: UnifiedFile[];
  searchResults: SearchResult[];
  debouncedSearch: string;
  hasAnyFilter: boolean;
  hasMore: boolean;
  hasClientOnlyFilter: boolean;
  allFilesCount: number;
  totalFiles: number;
  onView: (fileId: string) => void;
  onLoadMore: () => void;
}) {
  if (isLoading || isSearching) {
    return (
      <div className="space-y-2">
        {["fskel-1", "fskel-2", "fskel-3", "fskel-4", "fskel-5"].map((key) => (
          <Skeleton key={key} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  }

  if (isInSearchMode) {
    if (searchResults.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
          <MagnifyingGlassIcon size={32} className="text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No results for "{debouncedSearch}"</p>
          <p className="mt-1 text-xs text-muted-foreground">Try a different search term</p>
        </div>
      );
    }

    return (
      <>
        <div className="mb-2 text-xs text-muted-foreground">
          {searchResults.length} result{searchResults.length === 1 ? "" : "s"} for "{debouncedSearch}"
        </div>
        <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="flex-1">Name</span>
          <span className="w-24 text-center">Source</span>
          <span className="w-16 text-center">Type</span>
          <span className="w-20 text-center">Score</span>
          <span className="w-20 text-center">Similarity</span>
        </div>
        {searchResults.map((result) => (
          <SearchResultRow key={result.id} result={result} onView={() => onView(result.id)} />
        ))}
      </>
    );
  }

  if (filteredFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
        <FileTextIcon size={32} className="text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">
          {hasAnyFilter ? "No files match your filters" : "No files indexed yet"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {hasAnyFilter ? "Try adjusting your search or filters" : "Connect a source above to start syncing files"}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="flex-1">Name</span>
        <span className="w-24 text-center">Source</span>
        <span className="w-16 text-center">Type</span>
        <span className="w-20 text-center">Access</span>
        <span className="w-20 text-center">Status</span>
        <span className="w-24 text-right">Updated</span>
        <span className="w-5" />
      </div>
      {filteredFiles.map((file) => (
        <UnifiedFileRow key={file.id} file={file} onView={() => onView(file.id)} />
      ))}

      {hasMore && !hasClientOnlyFilter && (
        <div className="flex items-center justify-center py-4">
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isFetchingFiles}>
            {isFetchingFiles ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Loading...
              </>
            ) : (
              `Load more (${allFilesCount} of ${totalFiles})`
            )}
          </Button>
        </div>
      )}
    </>
  );
}

function SearchResultRow({ result, onView }: { result: SearchResult; onView: () => void }) {
  const def = getIntegration(result.source as IntegrationType);
  const Icon =
    result.contentCategory === "document"
      ? FileTextIcon
      : result.contentCategory === "image"
        ? FileTextIcon
        : TableIcon;

  return (
    <div
      className="flex items-center gap-3 border-b border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted/30 cursor-pointer"
      onClick={onView}
      onKeyDown={(e) => e.key === "Enter" && onView()}
    >
      <button type="button" onClick={onView} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{result.fileName}</p>
          {result.snippet ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{result.snippet}</p>
          ) : result.sourcePath ? (
            <p className="truncate text-[11px] text-muted-foreground">{result.sourcePath}</p>
          ) : result.summary ? (
            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{result.summary}</p>
          ) : null}
          {result.tags && (
            <div className="mt-1 flex gap-1 flex-wrap">
              {(() => {
                try {
                  return (JSON.parse(result.tags) as string[]).slice(0, 5).map((tag: string) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {tag}
                    </span>
                  ));
                } catch {
                  return null;
                }
              })()}
            </div>
          )}
        </div>
      </button>

      <span className="w-24 text-center">
        {def ? (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ConnectorLogo type={def.type} size={10} style={{ color: def.color }} />
            {def.name}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            {result.source}
          </Badge>
        )}
      </span>

      <span className="w-16 text-center">
        <Badge variant="secondary" className="text-[10px]">
          {result.contentCategory === "document" ? "Doc" : result.contentCategory === "image" ? "Img" : "Data"}
        </Badge>
      </span>

      <span className="w-20 text-center">
        <span className="font-mono text-xs text-muted-foreground">{result.score.toFixed(4)}</span>
      </span>

      <span className="w-20 text-center">
        {result.similarity != null ? (
          <span className="font-mono text-xs text-muted-foreground">{(result.similarity * 100).toFixed(1)}%</span>
        ) : (
          <span className="text-[10px] text-muted-foreground/50">FTS only</span>
        )}
      </span>
    </div>
  );
}

function UnifiedFileRow({ file, onView }: { file: UnifiedFile; onView: () => void }) {
  const def = getIntegration(file.source as IntegrationType);
  const Icon = file.contentCategory === "document" ? FileTextIcon : TableIcon;

  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted/30">
      <button type="button" onClick={onView} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{file.fileName}</p>
          {file.sourcePath && <p className="truncate text-[11px] text-muted-foreground">{file.sourcePath}</p>}
        </div>
      </button>

      <span className="w-24 text-center">
        {def ? (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ConnectorLogo type={def.type} size={10} style={{ color: def.color }} />
            {def.name}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            {file.source}
          </Badge>
        )}
      </span>

      <span className="w-16 text-center">
        <Badge variant="secondary" className="text-[10px]">
          {file.contentCategory === "document" ? "Doc" : "Data"}
        </Badge>
      </span>

      <span className="w-20 text-center">
        {file.accessScope === "restricted" ? (
          <Badge variant="outline" className="gap-0.5 text-[10px] text-amber-500 border-amber-500/30">
            <LockSimpleIcon size={10} weight="fill" />
            {file.accessCount ?? 0}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-0.5 text-[10px] text-muted-foreground">
            <GlobeIcon size={10} />
            Open
          </Badge>
        )}
      </span>

      <span className="w-20 text-center">
        {file.hasSummary ? (
          <Badge variant="outline" className="gap-0.5 text-[10px]">
            <SparkleIcon size={10} weight="fill" className="text-primary" />
            Enriched
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            Raw
          </Badge>
        )}
      </span>

      <span className="w-24 text-right text-xs text-muted-foreground">
        {formatRelativeTime(file.sourceUpdatedAt ?? file.sourceCreatedAt ?? file.syncedAt)}
      </span>

      {file.providerUrl ? (
        <a
          href={file.providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="w-5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <ArrowSquareOutIcon size={14} />
        </a>
      ) : (
        <span className="w-5" />
      )}
    </div>
  );
}
