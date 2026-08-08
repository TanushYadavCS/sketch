/**
 * FileDetailSheet — slide-over panel showing full file metadata, AI summary,
 * tags, access control list, and a content preview. Footer has an enrichment
 * trigger button.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { FileShareDialog } from "@/components/file-share-dialog";
import type { ConnectorConfig, EmailAddr, EmailThreadMessage, FileAccess, FileContent, LinkedEntity } from "@/lib/api";
import { ApiRequestError, api } from "@/lib/api";
import { type IntegrationType, getIntegration } from "@/lib/integrations";
import { useDashboardAuth } from "@/routes/dashboard";
import { MintTasksDialog } from "@/routes/files/mint-tasks-dialog";
import {
  ArrowSquareOutIcon,
  GlobeIcon,
  LinkIcon,
  ListChecksIcon,
  LockSimpleIcon,
  ShareNetworkIcon,
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

export function FileDetailSheet({
  fileId,
  connectors = [],
  onClose,
}: {
  fileId: string | null;
  connectors?: ConnectorConfig[];
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["file-content", fileId],
    queryFn: () => api.integrations.fileContent(fileId as string),
    enabled: !!fileId,
    retry: (failureCount, err) =>
      err instanceof ApiRequestError && (err.status === 403 || err.status === 404) ? false : failureCount < 3,
  });

  const file = data?.file;
  const access = data?.access;
  const entities = data?.entities ?? [];
  const forbidden = error instanceof ApiRequestError && error.status === 403;
  const notFound = error instanceof ApiRequestError && error.status === 404;
  // Admin 403s carry file metadata (name, source, scope, owner) for ops triage.
  // Non-admin 403s omit it — that's deliberate: the file isn't in their list.
  const gatedMeta = forbidden
    ? ((error as ApiRequestError).details as { file?: GatedFileMeta; access?: FileAccess } | undefined)
    : undefined;
  const titleFile = file?.fileName ?? gatedMeta?.file?.fileName;
  const connector = file ? connectors.find((c) => c.id === file.connectorConfigId) : undefined;

  return (
    <Sheet open={!!fileId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-base">{isLoading ? "Loading..." : (titleFile ?? "File")}</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-4 px-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-48 rounded-lg" />
            </div>
          ) : forbidden ? (
            gatedMeta?.file ? (
              <GatedFileDetail file={gatedMeta.file} access={gatedMeta.access ?? null} />
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                <LockSimpleIcon size={24} className="text-muted-foreground" />
                <p className="text-sm font-medium">You don't have access to this file's contents.</p>
                <p className="text-xs text-muted-foreground">Ask the file owner to share it with you.</p>
              </div>
            )
          ) : notFound ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">File not found.</p>
            </div>
          ) : file ? (
            <FileDetailContent file={file} access={access ?? null} entities={entities} />
          ) : (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">File not found.</p>
            </div>
          )}
        </div>

        {file && <FileDetailFooter fileId={file.id} fileName={file.fileName} connector={connector} />}
      </SheetContent>
    </Sheet>
  );
}

function FileDetailContent({
  file,
  access,
  entities,
}: { file: FileContent; access: FileAccess | null; entities: LinkedEntity[] }) {
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
            className={`gap-0.5 text-[10px] ${
              access.shareWithEveryone || access.scope !== "restricted"
                ? "text-muted-foreground"
                : "text-amber-500 border-amber-500/30"
            }`}
          >
            {access.shareWithEveryone ? (
              <>
                <GlobeIcon size={10} />
                Anyone in org
              </>
            ) : access.scope === "restricted" ? (
              <>
                <LockSimpleIcon size={10} weight="fill" />
                {(access.members?.length ?? 0) + (access.manualShares?.length ?? 0)} users
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

      {entities.length > 0 && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Linked Entities ({entities.length})
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {entities.map((entity) => (
              <Badge key={entity.id} variant="outline" className="gap-1 text-[10px]">
                {entity.name}
                <span className="text-muted-foreground">
                  {entity.sourceType === "person" ? (entity.subtype === "internal" ? "(int)" : "(ext)") : ""}
                </span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {access && ((access.members?.length ?? 0) > 0 || (access.manualShares?.length ?? 0) > 0) && (
        <AccessSection access={access} />
      )}

      {file.fileType === "email_message" && file.emailThread ? (
        <EmailThreadView
          connectorId={file.emailThread.connectorId}
          threadKey={file.emailThread.threadKey}
          fallbackContent={file.content}
        />
      ) : (
        file.content && <ContentPreview content={file.content} />
      )}
    </div>
  );
}

function formatAddr(addr: EmailAddr): string {
  return addr.name?.trim() ? `${addr.name} <${addr.email}>` : addr.email;
}

/**
 * Time-ordered thread view for email files. Falls back to the single-message
 * content preview if the thread can't be loaded — e.g. the endpoint 403s
 * because some messages aren't content-visible to this viewer.
 */
function EmailThreadView({
  connectorId,
  threadKey,
  fallbackContent,
}: { connectorId: string; threadKey: string; fallbackContent: string | null }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["email-thread", connectorId, threadKey],
    queryFn: () => api.integrations.emailThread(connectorId, threadKey),
    retry: (failureCount, err) =>
      err instanceof ApiRequestError && (err.status === 403 || err.status === 404) ? false : failureCount < 3,
  });

  if (isLoading) {
    return (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Conversation</p>
        <Skeleton className="mt-1 h-24 rounded-lg" />
      </div>
    );
  }

  if (error || !data || data.messages.length === 0) {
    return fallbackContent ? <ContentPreview content={fallbackContent} /> : null;
  }

  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Conversation ({data.messages.length})
      </p>
      <div className="mt-1 space-y-2">
        {data.messages.map((message) => (
          <EmailMessageCard key={message.indexedFileId} message={message} />
        ))}
      </div>
    </div>
  );
}

const MESSAGE_PREVIEW_LIMIT = 600;

function EmailMessageCard({ message }: { message: EmailThreadMessage }) {
  const [expanded, setExpanded] = useState(false);
  const content = message.content ?? "";
  const isLong = content.length > MESSAGE_PREVIEW_LIMIT;
  const shown = expanded || !isLong ? content : `${content.slice(0, MESSAGE_PREVIEW_LIMIT)}…`;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="space-y-0.5 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground">{formatAddr(message.from)}</p>
        <p>To: {message.to.map(formatAddr).join(", ") || "—"}</p>
        {message.cc.length > 0 && <p>Cc: {message.cc.map(formatAddr).join(", ")}</p>}
        {message.sentAt && <p>{new Date(message.sentAt).toLocaleString()}</p>}
      </div>
      {message.subject && <p className="mt-1 text-xs font-medium">{message.subject}</p>}
      {content && <pre className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{shown}</pre>}
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-primary hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {message.providerUrl && (
        <a
          href={message.providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          Open in source
          <ArrowSquareOutIcon size={10} />
        </a>
      )}
    </div>
  );
}

interface GatedFileMeta {
  id: string;
  fileName: string;
  fileType: string | null;
  source: string;
  sourcePath: string | null;
  syncedAt: string;
  enrichmentStatus: string;
}

/** Admin-only "you can see metadata, not contents" view for gated files. */
function GatedFileDetail({ file, access }: { file: GatedFileMeta; access: FileAccess | null }) {
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
        {access && (
          <Badge
            variant="outline"
            className={`gap-0.5 text-[10px] ${
              access.scope === "restricted" ? "text-amber-500 border-amber-500/30" : "text-muted-foreground"
            }`}
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

      <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-8 text-center">
        <LockSimpleIcon size={20} className="text-muted-foreground" />
        <p className="text-sm font-medium">Contents hidden</p>
        <p className="text-xs text-muted-foreground">
          Admin role grants ops access to file metadata, not private contents. Ask a scope member to share if you need
          to read it.
        </p>
      </div>

      {access && access.members.length > 0 && <AccessSection access={access} />}
    </div>
  );
}

const CONTENT_PREVIEW_LIMIT = 2000;

function ContentPreview({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > CONTENT_PREVIEW_LIMIT;
  const displayContent = expanded || !isLong ? content : `${content.slice(0, CONTENT_PREVIEW_LIMIT)}\u2026`;

  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Content</p>
      <pre
        className={`mt-1 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap ${expanded ? "max-h-[70vh]" : "max-h-96"}`}
      >
        {displayContent}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] text-primary hover:underline"
        >
          {expanded ? "Show less" : `Show full content (${(content.length / 1000).toFixed(1)}k chars)`}
        </button>
      )}
    </div>
  );
}

function FileDetailFooter({
  fileId,
  fileName,
  connector,
}: {
  fileId: string;
  fileName: string;
  connector?: ConnectorConfig;
}) {
  const queryClient = useQueryClient();
  const auth = useDashboardAuth();
  const isAdmin = auth.role === "admin";
  const canManageShares = connector?.canManage === true;
  const canEnrich = connector?.canEnrich === true;
  const [shareOpen, setShareOpen] = useState(false);
  const [mintOpen, setMintOpen] = useState(false);

  const canMint = connector?.canMint === true;

  const enrichMutation = useMutation({
    mutationFn: () => api.integrations.enrichFile(fileId),
    onSuccess: () => {
      toast.success("Enrichment started — check server logs");
      queryClient.invalidateQueries({ queryKey: ["file-content", fileId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!canManageShares && !canEnrich && !canMint) return null;

  return (
    <div className="border-t border-border px-4 py-3 flex gap-2">
      {canManageShares && (
        <Button size="sm" variant="outline" className="flex-1 gap-1.5 text-xs" onClick={() => setShareOpen(true)}>
          <ShareNetworkIcon size={12} />
          Share
        </Button>
      )}
      {canEnrich && (
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5 text-xs"
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
              Enrich
            </>
          )}
        </Button>
      )}
      {canMint && (
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5 text-xs"
          onClick={() => setMintOpen(true)}
          disabled={mintOpen}
        >
          <ListChecksIcon size={12} />
          Mint tasks
        </Button>
      )}
      {canMint && <MintTasksDialog fileId={fileId} fileName={fileName} open={mintOpen} onOpenChange={setMintOpen} />}
      {canManageShares && (
        <FileShareDialog
          fileId={fileId}
          fileName={fileName}
          open={shareOpen}
          onOpenChange={setShareOpen}
          canManage={canManageShares}
          canShareWithEveryone={isAdmin && canManageShares}
        />
      )}
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
  const members = access.members ?? [];
  const manualShares = access.manualShares ?? [];
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

      {manualShares.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Manually shared ({manualShares.length})
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {manualShares.map((share) => (
              <Badge key={share.email} variant="outline" className="text-[10px]">
                {share.email}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
