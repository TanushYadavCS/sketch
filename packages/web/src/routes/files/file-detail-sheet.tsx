/**
 * FileDetailSheet — slide-over panel showing full file metadata, AI summary,
 * tags, access control list, and a content preview. Footer has an enrichment
 * trigger button.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import type { FileAccess, FileContent } from "@/lib/api";
import { api } from "@/lib/api";
import { type IntegrationType, getIntegration } from "@/lib/integrations";
import {
  ArrowSquareOutIcon,
  GlobeIcon,
  LinkIcon,
  LockSimpleIcon,
  SparkleIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export function FileDetailSheet({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["file-content", fileId],
    queryFn: () => api.integrations.fileContent(fileId as string),
    enabled: !!fileId,
  });

  const file = data?.file;
  const access = data?.access;

  return (
    <Sheet open={!!fileId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-base">{isLoading ? "Loading..." : (file?.fileName ?? "File")}</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-4 px-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-48 rounded-lg" />
            </div>
          ) : file ? (
            <FileDetailContent file={file} access={access ?? null} />
          ) : (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">File not found.</p>
            </div>
          )}
        </div>

        {file && <FileDetailFooter fileId={file.id} />}
      </SheetContent>
    </Sheet>
  );
}

function FileDetailContent({ file, access }: { file: FileContent; access: FileAccess | null }) {
  const def = getIntegration(file.source as IntegrationType);

  return (
    <div className="space-y-4 px-4 pb-6">
      <div className="flex flex-wrap gap-2">
        {def && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ConnectorLogo type={def.type} size={10} style={{ color: def.color }} />
            {def.name}
          </Badge>
        )}
        {file.fileType && (
          <Badge variant="secondary" className="text-[10px]">
            {file.fileType}
          </Badge>
        )}
        {file.enrichmentStatus === "enriched" && (
          <Badge variant="outline" className="gap-0.5 text-[10px]">
            <SparkleIcon size={10} weight="fill" className="text-primary" />
            Enriched
          </Badge>
        )}
        {access && (
          <Badge
            variant="outline"
            className={`gap-0.5 text-[10px] ${access.scope === "restricted" ? "text-amber-500 border-amber-500/30" : "text-muted-foreground"}`}
          >
            {access.scope === "restricted" ? (
              <>
                <LockSimpleIcon size={10} weight="fill" />
                {access.members.length} users
              </>
            ) : (
              <>
                <GlobeIcon size={10} />
                Open
              </>
            )}
          </Badge>
        )}
      </div>

      {file.sourcePath && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Path</p>
          <p className="mt-1 text-xs text-muted-foreground">{file.sourcePath}</p>
        </div>
      )}

      {file.providerUrl && (
        <a
          href={file.providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          Open in source
          <ArrowSquareOutIcon size={12} />
        </a>
      )}

      {file.summary && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">AI Summary</p>
          <div className="mt-1 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <p className="font-mono text-xs leading-relaxed">{file.summary}</p>
          </div>
        </div>
      )}

      {file.contextNote && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Context Note</p>
          <p className="mt-1 text-sm text-muted-foreground">{file.contextNote}</p>
        </div>
      )}

      {file.tags && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tags</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {(() => {
              try {
                return (JSON.parse(file.tags) as string[]).map((tag: string) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">
                    {tag}
                  </Badge>
                ));
              } catch {
                return null;
              }
            })()}
          </div>
        </div>
      )}

      {access && access.members.length > 0 && <AccessSection access={access} />}

      {file.content && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Content Preview</p>
          <pre className="mt-1 max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {file.content.length > 2000 ? `${file.content.slice(0, 2000)}\u2026` : file.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function FileDetailFooter({ fileId }: { fileId: string }) {
  const queryClient = useQueryClient();

  const enrichMutation = useMutation({
    mutationFn: () => api.integrations.enrichFile(fileId),
    onSuccess: () => {
      toast.success("Enrichment started — check server logs");
      queryClient.invalidateQueries({ queryKey: ["file-content", fileId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="border-t border-border px-4 py-3">
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5 text-xs"
        onClick={() => enrichMutation.mutate()}
        disabled={enrichMutation.isPending}
      >
        {enrichMutation.isPending ? (
          <>
            <SpinnerGapIcon size={12} className="animate-spin" />
            Enriching...
          </>
        ) : (
          <>
            <SparkleIcon size={12} />
            Generate Summary & Embeddings
          </>
        )}
      </Button>
    </div>
  );
}

const COLLAPSED_MEMBER_LIMIT = 3;

function memberDisplayName(member: { userName: string | null; email: string }) {
  return member.userName ?? member.email;
}

function memberInitial(member: { userName: string | null; email: string }) {
  if (member.userName) return member.userName[0].toUpperCase();
  return member.email[0].toUpperCase();
}

function AccessSection({ access }: { access: FileAccess }) {
  const [expanded, setExpanded] = useState(false);
  const members = access.members;
  const mappedCount = members.filter((m) => m.mapped).length;
  const showExpand = members.length > COLLAPSED_MEMBER_LIMIT;
  const visibleMembers = expanded ? members : members.slice(0, COLLAPSED_MEMBER_LIMIT);
  const hiddenCount = members.length - COLLAPSED_MEMBER_LIMIT;

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Access ({members.length})
        </p>
        {mappedCount > 0 && (
          <Badge variant="outline" className="text-[9px] text-green-500 border-green-500/30">
            {mappedCount} mapped
          </Badge>
        )}
      </div>

      {!expanded && (
        <button
          type="button"
          onClick={() => showExpand && setExpanded(true)}
          className={`mt-1.5 flex items-center gap-1 ${showExpand ? "cursor-pointer" : "cursor-default"}`}
        >
          <div className="flex -space-x-1.5">
            {visibleMembers.map((member) => (
              <div
                key={member.email}
                className={`flex size-6 items-center justify-center rounded-full border-2 border-background text-[9px] font-medium ${
                  member.mapped ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}
                title={memberDisplayName(member)}
              >
                {memberInitial(member)}
              </div>
            ))}
          </div>
          <span className="ml-1 text-xs text-muted-foreground">
            {visibleMembers.map((m) => memberDisplayName(m)).join(", ")}
            {showExpand && <span className="ml-1 font-medium text-foreground">+{hiddenCount} more</span>}
          </span>
        </button>
      )}

      {expanded && (
        <div className="mt-1.5 space-y-1">
          {members.map((member) => (
            <div key={member.email} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
              <div
                className={`flex size-6 items-center justify-center rounded-full text-[10px] font-medium ${
                  member.mapped ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}
              >
                {memberInitial(member)}
              </div>
              <div className="min-w-0 flex-1">
                {member.userName ? (
                  <p className="truncate text-xs font-medium">{member.userName}</p>
                ) : (
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                )}
              </div>
              {member.mapped ? (
                <Badge variant="outline" className="text-[9px] text-green-500 border-green-500/30">
                  <LinkIcon size={8} className="mr-0.5" />
                  Mapped
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[9px]">
                  Unmapped
                </Badge>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="w-full rounded-md py-1 text-center text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
          >
            Show less
          </button>
        </div>
      )}
    </div>
  );
}
