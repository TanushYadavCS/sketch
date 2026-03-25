import { api } from "@/lib/api";
import { CheckIcon, MagnifyingGlassIcon, SpinnerGapIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import type { IntegrationApp } from "@sketch/shared";
/**
 * Add Integration dialog: catalog search with infinite scroll + OAuth popup flow.
 */
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { getAbbreviation } from "@sketch/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type AddIntegrationStep =
  | { kind: "search" }
  | { kind: "oauth"; app: IntegrationApp }
  | { kind: "oauth_cancelled"; app: IntegrationApp }
  | { kind: "popup_blocked"; app: IntegrationApp }
  | { kind: "connected"; app: IntegrationApp };

export function AddIntegrationDialog({
  open,
  onOpenChange,
  providerId,
  connectedAppIds,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  connectedAppIds: Set<string>;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<AddIntegrationStep>({ kind: "search" });
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<IntegrationApp[]>([]);
  const [isLoadingApps, setIsLoadingApps] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const oauthWindowRef = useRef<Window | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const loadApps = useCallback(
    async (query: string, cursor: string | null, append: boolean) => {
      setIsLoadingApps(true);
      try {
        const result = await api.mcpServers.listApps(providerId, query || undefined, 20, cursor ?? undefined);
        if (append) {
          setApps((prev) => [...prev, ...result.apps]);
        } else {
          setApps(result.apps);
        }
        setHasMore(result.pageInfo.hasMore);
        setEndCursor(result.pageInfo.endCursor);
      } catch {
        toast.error("Failed to load apps");
      } finally {
        setIsLoadingApps(false);
      }
    },
    [providerId],
  );

  useEffect(() => {
    if (open && step.kind === "search") {
      setApps([]);
      setHasMore(false);
      setEndCursor(null);
      loadApps("", null, false);
    }
  }, [open, step.kind, loadApps]);

  useEffect(() => {
    if (!open || step.kind !== "search") return;
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setEndCursor(null);
      loadApps(search, null, false);
    }, 300);
    return () => clearTimeout(searchTimeoutRef.current);
  }, [search, open, step.kind, loadApps]);

  useEffect(() => {
    if (!hasMore || isLoadingApps || step.kind !== "search") return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingApps) {
          loadApps(search, endCursor, true);
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingApps, search, endCursor, step.kind, loadApps]);

  const resetAndClose = () => {
    cancelledRef.current = true;
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = undefined;
    }
    setStep({ kind: "search" });
    setSearch("");
    setApps([]);
    setHasMore(false);
    setEndCursor(null);
    if (oauthWindowRef.current && !oauthWindowRef.current.closed) {
      oauthWindowRef.current.close();
    }
    oauthWindowRef.current = null;
    onOpenChange(false);
  };

  const handleStartOAuth = async (app: IntegrationApp) => {
    if (connectedAppIds.has(app.id)) return;
    setStep({ kind: "oauth", app });

    try {
      const callbackUrl = `${window.location.origin}/connections/callback`;
      const result = await api.mcpServers.createConnection(providerId, app.id, callbackUrl);
      const popup = window.open(result.redirectUrl, "_blank", "width=600,height=700");

      if (!popup || popup.closed) {
        setStep({ kind: "popup_blocked", app });
        return;
      }

      oauthWindowRef.current = popup;
      cancelledRef.current = false;

      const verifyConnection = async () => {
        try {
          const connections = await api.mcpServers.listConnections(providerId);
          const connected = connections.some((c) => c.appId === app.id);
          if (cancelledRef.current) return;
          if (connected) {
            toast.success("App connected successfully!");
            onSuccess();
            resetAndClose();
          } else {
            toast.error("App connection cancelled");
            setStep({ kind: "oauth_cancelled", app });
          }
        } catch {
          if (cancelledRef.current) return;
          toast.error("Could not verify connection status");
          setStep({ kind: "oauth_cancelled", app });
        }
      };

      pollIntervalRef.current = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = undefined;
          oauthWindowRef.current = null;
          verifyConnection();
        }
      }, 500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start connection");
      setStep({ kind: "search" });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
        else onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {step.kind === "search" && (
          <>
            <DialogHeader>
              <DialogTitle>Add integration</DialogTitle>
              <DialogDescription>Search from apps available via your integration provider.</DialogDescription>
            </DialogHeader>

            <div className="py-2">
              <div className="relative">
                <MagnifyingGlassIcon
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search integrations..."
                  autoFocus
                  className="pl-9"
                />
              </div>
            </div>

            <div ref={scrollContainerRef} className="max-h-[50vh] overflow-y-auto -mx-6 px-6">
              {apps.length === 0 && !isLoadingApps ? (
                <div className="flex flex-col items-center py-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    {search ? `No integrations found for "${search}"` : "No apps available"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    {apps.map((app) => (
                      <AppRow
                        key={app.id}
                        app={app}
                        isConnected={connectedAppIds.has(app.id)}
                        onConnect={() => handleStartOAuth(app)}
                      />
                    ))}
                  </div>

                  <div ref={sentinelRef} className="h-4" />

                  {isLoadingApps && (
                    <div className="flex justify-center py-4">
                      <SpinnerGapIcon size={20} className="animate-spin text-muted-foreground" />
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
            </DialogFooter>
          </>
        )}

        {step.kind === "oauth" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-[10px] font-bold">
                  {step.app.name.slice(0, 2).toUpperCase()}
                </div>
                Connecting {step.app.name}
              </DialogTitle>
              <DialogDescription>Authorizing via OAuth, this opens in a new window.</DialogDescription>
            </DialogHeader>

            <div className="py-6">
              <div className="rounded-lg border border-border bg-muted/30 p-6">
                <div className="flex flex-col items-center text-center">
                  <div className="flex size-14 items-center justify-center rounded-xl bg-muted text-lg font-bold">
                    {step.app.name.slice(0, 2).toUpperCase()}
                  </div>
                  <p className="mt-4 text-sm font-medium">Authorize Sketch to access {step.app.name}</p>
                  <div className="mt-5 flex items-center gap-2">
                    <SpinnerGapIcon size={16} className="animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">Waiting for authorization...</span>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  toast.error("App connection cancelled");
                  resetAndClose();
                }}
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {step.kind === "oauth_cancelled" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-full bg-muted">
                  <XCircleIcon size={16} className="text-muted-foreground" />
                </div>
                Authorization cancelled
              </DialogTitle>
              <DialogDescription>
                You closed the authorization window. {step.app.name} was not connected. Try again when ready.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter>
              <Button variant="outline" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button onClick={() => handleStartOAuth(step.app)}>Try again</Button>
            </DialogFooter>
          </>
        )}

        {step.kind === "popup_blocked" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
                  <WarningIcon size={16} weight="fill" className="text-amber-600" />
                </div>
                Popup blocked
              </DialogTitle>
              <DialogDescription>
                Your browser blocked the authorization popup. Allow popups for this page and try again.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter>
              <Button variant="outline" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button onClick={() => handleStartOAuth(step.app)}>Try again</Button>
            </DialogFooter>
          </>
        )}

        {step.kind === "connected" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                  <CheckIcon size={16} weight="bold" className="text-emerald-600" />
                </div>
                {step.app.name} connected
              </DialogTitle>
              <DialogDescription>Your app has been connected successfully.</DialogDescription>
            </DialogHeader>

            <DialogFooter>
              <Button
                className="w-full"
                onClick={() => {
                  onSuccess();
                  resetAndClose();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AppRow({
  app,
  isConnected,
  onConnect,
}: {
  app: IntegrationApp;
  isConnected: boolean;
  onConnect: () => void;
}) {
  const abbrev = getAbbreviation(app.name);

  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={isConnected}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        isConnected ? "cursor-default opacity-50" : "hover:bg-muted/50"
      }`}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-[11px] font-bold">
        {app.icon ? <img src={app.icon} alt="" className="size-6 rounded" /> : abbrev}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{app.name}</p>
        {app.description && <p className="text-xs text-muted-foreground">{app.description}</p>}
      </div>
      {isConnected && <span className="text-xs text-muted-foreground">Already added</span>}
    </button>
  );
}
