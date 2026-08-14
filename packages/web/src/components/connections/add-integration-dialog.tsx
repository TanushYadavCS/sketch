import { api } from "@/lib/api";
import { CheckIcon, MagnifyingGlassIcon, SpinnerGapIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import {
  type CliIntegrationCatalogApp,
  type CliIntegrationConnection,
  type IntegrationApp,
  type IntegrationConnection,
  isCanvasBlockedCliAppId,
  managedCliIntegrationAppId,
} from "@sketch/shared";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppIcon } from "./app-icon";
import { isNativeCanvasAppConnection, isOwnedOrPersonalAppConnection } from "./connection-status";

type AddIntegrationStep =
  | { kind: "search" }
  | { kind: "direct_loading"; appId: string }
  | { kind: "direct_ready"; app: IntegrationApp; redirectUrl: string }
  | { kind: "direct_not_found"; appId: string }
  | { kind: "oauth"; app: IntegrationApp }
  | { kind: "oauth_cancelled"; app: IntegrationApp }
  | { kind: "popup_blocked"; app: IntegrationApp }
  | { kind: "connected"; app: IntegrationApp };

const OAUTH_POPUP_CLOSED_GRACE_MS = 30_000;

function appNameFromId(appId: string): string {
  return appId
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
}

export function AddIntegrationDialog({
  open,
  onOpenChange,
  providerId,
  connectedAppIds,
  initialAppId,
  initialSearch,
  onSuccess,
  cliCatalog,
  cliConnections,
  onOpenGithubSetup,
  onOpenLinearSetup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  connectedAppIds: Set<string>;
  initialAppId?: string | null;
  initialSearch?: string | null;
  onSuccess: (app?: IntegrationApp, connection?: IntegrationConnection) => void;
  cliCatalog?: CliIntegrationCatalogApp[];
  cliConnections?: CliIntegrationConnection[];
  onOpenGithubSetup?: () => void;
  onOpenLinearSetup?: () => void;
}) {
  const [step, setStep] = useState<AddIntegrationStep>({ kind: "search" });
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<IntegrationApp[]>([]);
  const appsRef = useRef<IntegrationApp[]>([]);
  const [isLoadingApps, setIsLoadingApps] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const oauthWindowRef = useRef<Window | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const oauthAttemptRef = useRef(0);
  const cancelledRef = useRef(false);
  const directRequestRef = useRef<string | null>(null);
  const cliApps = useMemo(() => cliCatalog ?? [], [cliCatalog]);
  const connectedCliIds = new Set((cliConnections ?? []).map((connection) => connection.appId.trim().toLowerCase()));

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
        const cliAppIds = new Set(cliApps.map((app) => app.id.trim().toLowerCase()));
        const canvasApps = result.apps.filter(
          (app) =>
            !cliAppIds.has(app.id.trim().toLowerCase()) &&
            !isCanvasBlockedCliAppId(app.id) &&
            !isCanvasBlockedCliAppId(app.name),
        );
        const matchingCliApps = query.trim()
          ? cliApps.filter((app) =>
              `${app.name} ${app.id} ${app.description}`.toLowerCase().includes(query.trim().toLowerCase()),
            )
          : cliApps;
        const mergedApps = append ? [...appsRef.current, ...canvasApps] : [...matchingCliApps, ...canvasApps];
        if (append) {
          appsRef.current = [...appsRef.current, ...canvasApps];
          setApps(appsRef.current);
        } else {
          appsRef.current = mergedApps;
          setApps(mergedApps);
        }
        setHasMore(result.pageInfo.hasMore);
        setEndCursor(result.pageInfo.endCursor);
      } catch {
        toast.error("Failed to load apps");
      } finally {
        setIsLoadingApps(false);
      }
    },
    [cliApps, providerId],
  );

  useEffect(() => {
    if (!open) {
      directRequestRef.current = null;
      return;
    }
    const managedInitialAppId = initialAppId ? managedCliIntegrationAppId(initialAppId) : null;
    if (managedInitialAppId) {
      if (managedInitialAppId === "linear") onOpenLinearSetup?.();
      else onOpenGithubSetup?.();
      return;
    }

    const requestedAppId = initialAppId?.trim();
    if (!requestedAppId || directRequestRef.current === requestedAppId) return;
    const appId = requestedAppId;

    let cancelled = false;
    directRequestRef.current = appId;
    setStep({ kind: "direct_loading", appId });
    setSearch("");
    appsRef.current = [];
    setApps([]);
    setHasMore(false);
    setEndCursor(null);

    async function loadDirectApp() {
      try {
        const callbackUrl = `${window.location.origin}/integrations/callback`;
        const result = await api.mcpServers.createConnectionIntent(providerId, appId, callbackUrl);
        if (!cancelled) setStep({ kind: "direct_ready", app: result.app, redirectUrl: result.redirectUrl });
      } catch {
        if (!cancelled) {
          toast.error("Failed to load integration");
          setStep({ kind: "direct_not_found", appId });
        }
      }
    }

    void loadDirectApp();
    return () => {
      cancelled = true;
    };
  }, [open, initialAppId, providerId, onOpenGithubSetup, onOpenLinearSetup]);

  useEffect(() => {
    if (open && !initialAppId?.trim() && step.kind === "search") {
      const query = initialSearch?.trim() ?? "";
      setSearch(query);
      appsRef.current = [];
      setApps([]);
      setHasMore(false);
      setEndCursor(null);
      loadApps(query, null, false);
    }
  }, [open, step.kind, initialAppId, initialSearch, loadApps]);

  useEffect(() => {
    if (!open || initialAppId?.trim() || step.kind !== "search") return;
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setEndCursor(null);
      loadApps(search, null, false);
    }, 300);
    return () => clearTimeout(searchTimeoutRef.current);
  }, [search, open, step.kind, initialAppId, loadApps]);

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
    oauthAttemptRef.current += 1;
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = undefined;
    }
    setStep({ kind: "search" });
    setSearch("");
    appsRef.current = [];
    setApps([]);
    setHasMore(false);
    setEndCursor(null);
    directRequestRef.current = null;
    if (oauthWindowRef.current && !oauthWindowRef.current.closed) {
      oauthWindowRef.current.close();
    }
    oauthWindowRef.current = null;
    onOpenChange(false);
  };

  const startOAuthWindow = (
    app: IntegrationApp,
    redirectUrl: string,
    preopenedPopup?: Window | null,
    attemptId = oauthAttemptRef.current + 1,
  ) => {
    if (attemptId > oauthAttemptRef.current) oauthAttemptRef.current = attemptId;
    if (oauthAttemptRef.current !== attemptId) {
      if (preopenedPopup && !preopenedPopup.closed) preopenedPopup.close();
      return;
    }
    if (connectedAppIds.has(app.id)) {
      if (preopenedPopup && !preopenedPopup.closed) preopenedPopup.close();
      return;
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = undefined;
    }
    setStep({ kind: "oauth", app });

    const popup = preopenedPopup ?? window.open(redirectUrl, "_blank", "width=600,height=700");

    if (!popup || popup.closed) {
      setStep({ kind: "popup_blocked", app });
      return;
    }
    if (preopenedPopup) popup.location.href = redirectUrl;

    oauthWindowRef.current = popup;
    cancelledRef.current = false;
    let popupClosedAt: number | null = null;
    let isVerifying = false;
    let finalizeAfterVerify = false;

    const stopPolling = () => {
      clearInterval(intervalId);
      if (pollIntervalRef.current === intervalId) pollIntervalRef.current = undefined;
      oauthWindowRef.current = null;
    };

    const verifyConnection = async (finalIfMissing: boolean) => {
      if (oauthAttemptRef.current !== attemptId) return;
      if (isVerifying) {
        if (finalIfMissing) finalizeAfterVerify = true;
        return;
      }
      isVerifying = true;
      const shouldFinalizeIfMissing = finalIfMissing || finalizeAfterVerify;
      finalizeAfterVerify = false;
      try {
        const connections = await api.mcpServers.listConnections(providerId);
        const matchingConnections = connections.filter((c) => c.appId === app.id && isOwnedOrPersonalAppConnection(c));
        const connected = matchingConnections.find(isNativeCanvasAppConnection) ?? matchingConnections[0];
        if (cancelledRef.current || oauthAttemptRef.current !== attemptId) return;
        if (connected) {
          toast.success("App connected successfully!");
          onSuccess({ ...app, connectionId: connected.id }, connected);
          resetAndClose();
        } else if (shouldFinalizeIfMissing) {
          stopPolling();
          toast.error("App connection cancelled");
          setStep({ kind: "oauth_cancelled", app });
        }
      } catch {
        if (cancelledRef.current || oauthAttemptRef.current !== attemptId) return;
        stopPolling();
        toast.error("Could not verify connection status");
        setStep({ kind: "oauth_cancelled", app });
      } finally {
        isVerifying = false;
        if (finalizeAfterVerify && !cancelledRef.current && oauthAttemptRef.current === attemptId) {
          void verifyConnection(true);
        }
      }
    };

    const intervalId = setInterval(() => {
      if (oauthAttemptRef.current !== attemptId) {
        clearInterval(intervalId);
        return;
      }
      if (popup.closed) {
        popupClosedAt ??= Date.now();
        const finalIfMissing = Date.now() - popupClosedAt >= OAUTH_POPUP_CLOSED_GRACE_MS;
        void verifyConnection(finalIfMissing);
      } else {
        popupClosedAt = null;
      }
    }, 500);
    pollIntervalRef.current = intervalId;
  };

  const handleStartOAuth = async (app: IntegrationApp) => {
    if (connectedAppIds.has(app.id)) return;
    const attemptId = oauthAttemptRef.current + 1;
    oauthAttemptRef.current = attemptId;
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = undefined;
    }
    setStep({ kind: "oauth", app });
    const popup = window.open("about:blank", "_blank", "width=600,height=700");

    if (!popup || popup.closed) {
      setStep({ kind: "popup_blocked", app });
      return;
    }

    try {
      const callbackUrl = `${window.location.origin}/integrations/callback`;
      const result = await api.mcpServers.createConnectionIntent(providerId, app.id, callbackUrl, app);
      startOAuthWindow(result.app, result.redirectUrl, popup, attemptId);
    } catch (err) {
      if (!popup.closed) popup.close();
      if (oauthAttemptRef.current !== attemptId) return;
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
                        isConnected={connectedAppIds.has(app.id) || connectedCliIds.has(app.id.trim().toLowerCase())}
                        onConnect={() => {
                          if (
                            app.executionMode === "cli" ||
                            app.executionMode === "api" ||
                            isCanvasBlockedCliAppId(app.id) ||
                            isCanvasBlockedCliAppId(app.name)
                          ) {
                            if (managedCliIntegrationAppId(app.id) === "linear") onOpenLinearSetup?.();
                            else onOpenGithubSetup?.();
                            return;
                          }
                          void handleStartOAuth(app);
                        }}
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

        {step.kind === "direct_loading" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {appNameFromId(step.appId)}</DialogTitle>
              <DialogDescription>Loading the integration setup.</DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <AppIcon name={appNameFromId(step.appId)} className="size-10 rounded-lg text-xs" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Preparing connection</p>
                <p className="text-xs text-muted-foreground">Fetching the exact app from your provider.</p>
              </div>
              <SpinnerGapIcon size={18} className="animate-spin text-muted-foreground" aria-hidden />
            </div>
          </>
        )}

        {step.kind === "direct_ready" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {step.app.name}</DialogTitle>
              <DialogDescription>Authorize this app through your integration provider.</DialogDescription>
            </DialogHeader>

            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-start gap-3">
                <AppIcon name={step.app.name} icon={step.app.icon} className="size-10 rounded-lg text-xs" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{step.app.name}</p>
                  {step.app.description ? (
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {step.app.description}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">Ready to connect to Sketch.</p>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button
                onClick={() => startOAuthWindow(step.app, step.redirectUrl)}
                disabled={connectedAppIds.has(step.app.id)}
              >
                {connectedAppIds.has(step.app.id) ? "Already added" : `Connect ${step.app.name}`}
              </Button>
            </DialogFooter>
          </>
        )}

        {step.kind === "direct_not_found" && (
          <>
            <DialogHeader>
              <DialogTitle>Integration unavailable</DialogTitle>
              <DialogDescription>
                {appNameFromId(step.appId)} could not be found in your integration provider catalog.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter>
              <Button variant="outline" onClick={resetAndClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}

        {step.kind === "oauth" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <AppIcon name={step.app.name} icon={step.app.icon} className="size-8 rounded-lg text-[10px]" />
                Connecting {step.app.name}
              </DialogTitle>
              <DialogDescription>Authorizing via OAuth, this opens in a new window.</DialogDescription>
            </DialogHeader>

            <div className="py-6">
              <div className="rounded-lg border border-border bg-muted/30 p-6">
                <div className="flex flex-col items-center text-center">
                  <AppIcon name={step.app.name} icon={step.app.icon} className="size-14 rounded-xl text-lg" />
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
                variant="ghost"
                className="w-full gap-1.5 hover:bg-brand-accent/8"
                onClick={() => {
                  onSuccess(step.app);
                  resetAndClose();
                }}
              >
                <CheckIcon size={14} weight="bold" />
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
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={isConnected}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        isConnected ? "cursor-default opacity-50" : "hover:bg-muted/50"
      }`}
    >
      <AppIcon name={app.name} icon={app.icon} className="size-9 rounded-lg text-[11px]" imageClassName="size-6" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{app.name}</p>
        {app.description && <p className="text-xs text-muted-foreground">{app.description}</p>}
      </div>
      {isConnected && <span className="text-xs text-muted-foreground">Already added</span>}
    </button>
  );
}
