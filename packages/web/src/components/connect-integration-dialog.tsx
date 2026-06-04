/**
 * Generic connect dialog for integrations.
 * Reads auth fields and connect steps from the integration registry,
 * so adding a new integration requires zero dialog changes.
 *
 * Google Drive uses an OAuth redirect flow:
 * 1. Admin configures client_id + client_secret (one-time)
 * 2. "Connect with Google" redirects to Google's consent screen
 * 3. Callback auto-creates connector and triggers sync
 *
 * Other integrations connect immediately after credential validation.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { ScopeCount, ScopeGroup, ScopeItem, ScopeList, ScopeSelectAll, ScopeSubItem } from "@/components/scope-picker";
import { api } from "@/lib/api";
import type { IntegrationDefinition } from "@/lib/integrations";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CaretRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GoogleLogoIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react";
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
import { Label } from "@sketch/ui/components/label";
import { Textarea } from "@sketch/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface SharedDrive {
  id: string;
  name: string;
}

interface NotionPage {
  id: string;
  title: string;
  url: string;
}

interface ClickUpWorkspace {
  id: string;
  name: string;
  memberCount: number;
  spaces: Array<{ id: string; name: string; private: boolean }>;
}

interface ConnectIntegrationDialogProps {
  integration: IntegrationDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

export function ConnectIntegrationDialog({
  integration,
  open,
  onOpenChange,
  onConnected,
}: ConnectIntegrationDialogProps) {
  const auth = useDashboardAuth();
  const isAdmin = auth.role === "admin";
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  // Google Drive OAuth state
  const [step, setStep] = useState<"credentials" | "drives" | "notion-pages" | "clickup-workspaces" | "oauth-config">(
    "credentials",
  );
  const [sharedDrives, setSharedDrives] = useState<SharedDrive[]>([]);
  const [selectedDriveIds, setSelectedDriveIds] = useState<Set<string>>(new Set());
  const [rootFolders, setRootFolders] = useState<SharedDrive[]>([]);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());

  // ClickUp scope state
  const [clickUpWorkspaces, setClickUpWorkspaces] = useState<ClickUpWorkspace[]>([]);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<Set<string>>(new Set());
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(new Set());

  // Notion scope state
  const [notionRootPages, setNotionRootPages] = useState<NotionPage[]>([]);
  const [selectedNotionPageIds, setSelectedNotionPageIds] = useState<Set<string>>(new Set());
  const [notionBrowseId, setNotionBrowseId] = useState<string | null>(null);
  const [notionPagesScanned, setNotionPagesScanned] = useState(0);
  const [notionScanDone, setNotionScanDone] = useState(false);

  const isOAuthRedirect = integration?.oauthRedirect === true;

  // Notion browse polling — updates root pages list in real-time as scan progresses
  useEffect(() => {
    if (!notionBrowseId) return;
    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        try {
          const status = await api.integrations.browseNotionStatus(notionBrowseId);
          if (cancelled) break;

          setNotionPagesScanned(status.pagesScanned);
          setNotionRootPages(status.rootPages.map((p) => ({ id: p.id, title: p.title, url: p.url })));

          if (!status.scanning) {
            setNotionScanDone(true);
            if (status.error) {
              toast.error(`Notion scan failed: ${status.error}`);
            }
            break;
          }
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [notionBrowseId]);

  // Check if Google OAuth is configured (for OAuth redirect integrations)
  const oauthStatus = useQuery({
    queryKey: ["google-oauth-status"],
    queryFn: () => api.googleOAuth.status(),
    enabled: open && isOAuthRedirect,
  });

  const isOAuthConfigured = oauthStatus.data?.configured === true;

  // For OAuth redirect: start with oauth-config step if not configured
  useEffect(() => {
    if (open && isOAuthRedirect) {
      if (oauthStatus.isSuccess) {
        setStep(isOAuthConfigured ? "credentials" : "oauth-config");
      }
    }
  }, [open, isOAuthRedirect, oauthStatus.isSuccess, isOAuthConfigured]);

  /** Save Google OAuth client_id + client_secret. */
  const configureOAuthMutation = useMutation({
    mutationFn: async () => {
      const clientId = fieldValues.client_id?.trim();
      const clientSecret = fieldValues.client_secret?.trim();
      if (!clientId || !clientSecret) throw new Error("Client ID and Secret are required");
      await api.googleOAuth.configure(clientId, clientSecret);
    },
    onSuccess: () => {
      toast.success("Google OAuth configured.");
      oauthStatus.refetch();
      setStep("credentials");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to configure Google OAuth.");
    },
  });

  /** For non-OAuth-redirect integrations: connect directly (or browse scope first). */
  const validateMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      const credentials = buildCredentials();

      // ClickUp: browse workspaces and spaces, show picker
      if (integration.type === "clickup") {
        const apiKey = (credentials.api_key as string) ?? "";
        const result = await api.integrations.browseClickUp({ api_key: apiKey });
        setClickUpWorkspaces(result.workspaces);
        setSelectedWorkspaceIds(new Set());
        setSelectedSpaceIds(new Set());
        setStep("clickup-workspaces");
        return;
      }

      // Notion: validate creds, start background scan, show picker immediately
      if (integration.type === "notion") {
        const apiKey = (credentials.api_key as string) ?? "";
        const result = await api.integrations.browseNotionStart({ api_key: apiKey });
        setNotionBrowseId(result.browseId);
        setNotionRootPages([]);
        setNotionPagesScanned(0);
        setNotionScanDone(false);
        setSelectedNotionPageIds(new Set());
        setStep("notion-pages");
        return;
      }

      await api.integrations.connect({
        connectorType: integration.type,
        authType: integration.authType,
        credentials,
      });
    },
    onSuccess: () => {
      // For Notion/ClickUp, success means we loaded the scope picker — don't close
      if (integration?.type === "notion" || integration?.type === "clickup") return;
      toast.success(`${integration?.name} connected successfully.`);
      resetAndClose();
      onConnected();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to connect. Check your credentials and try again.");
    },
  });

  /** Notion: connect with selected root pages. */
  const connectWithNotionPagesMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      const credentials = buildCredentials();
      const scopeConfig = { rootPages: Array.from(selectedNotionPageIds) };
      return api.integrations.connect({
        connectorType: integration.type,
        authType: integration.authType,
        credentials,
        scopeConfig,
      });
    },
    onSuccess: () => {
      toast.success(`${integration?.name} connected successfully.`);
      resetAndClose();
      onConnected();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to connect.");
    },
  });

  /** ClickUp: connect with selected workspaces + spaces. */
  const connectWithClickUpMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      const credentials = buildCredentials();
      const scopeConfig = {
        workspaces: Array.from(selectedWorkspaceIds),
        spaces: Array.from(selectedSpaceIds),
      };
      return api.integrations.connect({
        connectorType: integration.type,
        authType: integration.authType,
        credentials,
        scopeConfig,
      });
    },
    onSuccess: () => {
      toast.success(`${integration?.name} connected successfully.`);
      resetAndClose();
      onConnected();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to connect.");
    },
  });

  /** Google Drive step 2: connect with selected drives or folders. */
  const connectWithDrivesMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      const credentials = buildCredentials();
      const scopeConfig =
        sharedDrives.length > 0
          ? { sharedDrives: Array.from(selectedDriveIds) }
          : { folders: Array.from(selectedFolderIds) };
      return api.integrations.connect({
        connectorType: integration.type,
        authType: integration.authType,
        credentials,
        scopeConfig,
      });
    },
    onSuccess: () => {
      toast.success(`${integration?.name} connected successfully.`);
      resetAndClose();
      onConnected();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to connect.");
    },
  });

  const buildCredentials = (): Record<string, unknown> => {
    const credentials: Record<string, unknown> = {};
    for (const field of integration?.authFields ?? []) {
      credentials[field.key] = fieldValues[field.key]?.trim() ?? "";
    }
    return credentials;
  };

  const resetAndClose = () => {
    setFieldValues({});
    setStep("credentials");
    setSharedDrives([]);
    setSelectedDriveIds(new Set());
    setRootFolders([]);
    setSelectedFolderIds(new Set());
    setClickUpWorkspaces([]);
    setSelectedWorkspaceIds(new Set());
    setSelectedSpaceIds(new Set());
    setNotionRootPages([]);
    setSelectedNotionPageIds(new Set());
    setNotionBrowseId(null);
    setNotionPagesScanned(0);
    setNotionScanDone(false);
    onOpenChange(false);
  };

  const handleFieldChange = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleDrive = (driveId: string) => {
    setSelectedDriveIds((prev) => {
      const next = new Set(prev);
      if (next.has(driveId)) next.delete(driveId);
      else next.add(driveId);
      return next;
    });
  };

  const toggleFolder = (folderId: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const handleConnectWithGoogle = () => {
    const url = api.googleOAuth.authorizeUrl(integration?.type);
    window.open(url, "_self");
  };

  const allFieldsFilled = integration?.authFields.every((f) => (fieldValues[f.key] ?? "").trim().length > 0) ?? false;
  const toggleNotionPage = (pageId: string) => {
    setSelectedNotionPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  const isPending =
    validateMutation.isPending ||
    connectWithDrivesMutation.isPending ||
    connectWithNotionPagesMutation.isPending ||
    connectWithClickUpMutation.isPending ||
    configureOAuthMutation.isPending;

  if (!integration) return null;

  const isMyDriveMode = sharedDrives.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
        else onOpenChange(next);
      }}
    >
      <DialogContent>
        {step === "oauth-config" && !isAdmin ? (
          /* Non-admin hits the OAuth-config step: surface the "ask your admin" empty state. */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                {integration.name} not yet configured
              </DialogTitle>
              <DialogDescription>
                Ask your admin to configure {integration.name} OAuth credentials. Once they do, you can connect with one
                click.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button>Got it</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : step === "oauth-config" ? (
          /* OAuth redirect: admin configures client_id + client_secret (one-time) */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Configure {integration.name}
              </DialogTitle>
              <DialogDescription>
                One-time setup: enter your Google OAuth credentials. After this, users can connect with one click.
              </DialogDescription>
            </DialogHeader>

            <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
              {integration.connectSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <a href={integration.credentialUrl} target="_blank" rel="noopener noreferrer">
                  Google Cloud Console
                  <ArrowSquareOutIcon className="size-3.5" />
                </a>
              </Button>
            </div>

            <div className="space-y-3">
              {integration.authFields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`auth-${field.key}`} className="text-xs">
                    {field.label}
                  </Label>
                  <Input
                    id={`auth-${field.key}`}
                    type={field.type === "password" ? "password" : "text"}
                    value={fieldValues[field.key] ?? ""}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    disabled={isPending}
                    className="font-mono text-xs"
                  />
                  {field.helpText && <p className="text-[11px] text-muted-foreground">{field.helpText}</p>}
                </div>
              ))}
            </div>

            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                <strong>Redirect URI</strong> — add this to your Google OAuth client's authorized redirect URIs:
              </p>
              <code className="mt-1 block text-[11px] text-foreground">
                {oauthStatus.data?.baseUrl || window.location.origin}/api/oauth/google/callback
              </code>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button onClick={() => configureOAuthMutation.mutate()} disabled={!allFieldsFilled || isPending}>
                {isPending ? (
                  <>
                    <SpinnerGapIcon size={14} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save & Continue"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : step === "credentials" && isOAuthRedirect ? (
          /* OAuth redirect: "Connect with Google" button */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Connect {integration.name}
              </DialogTitle>
              <DialogDescription>
                Sign in with your Google account to connect your Drive. Files will be synced automatically.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col items-center gap-4 py-4">
              <Button size="lg" className="w-full gap-2" onClick={handleConnectWithGoogle}>
                <GoogleLogoIcon size={18} weight="bold" />
                Connect with Google
              </Button>

              <p className="text-center text-[11px] text-muted-foreground">
                You'll be redirected to Google to authorize read-only access to your {integration.name}.
              </p>
            </div>

            {isAdmin && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setStep("oauth-config")}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Reconfigure OAuth
                </button>
              </div>
            )}
          </>
        ) : step === "credentials" ? (
          /* Non-OAuth-redirect: manual credential entry */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Connect {integration.name}
              </DialogTitle>
              <DialogDescription>{integration.description}</DialogDescription>
            </DialogHeader>

            <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
              {integration.connectSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <a href={integration.credentialUrl} target="_blank" rel="noopener noreferrer">
                  Get credentials
                  <ArrowSquareOutIcon className="size-3.5" />
                </a>
              </Button>
            </div>

            <div className="space-y-3">
              {integration.authFields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`auth-${field.key}`} className="text-xs">
                    {field.label}
                  </Label>
                  {field.type === "textarea" ? (
                    <Textarea
                      id={`auth-${field.key}`}
                      value={fieldValues[field.key] ?? ""}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      disabled={isPending}
                      className="min-h-24 font-mono text-xs"
                    />
                  ) : (
                    <Input
                      id={`auth-${field.key}`}
                      type={field.type === "password" ? "password" : "text"}
                      value={fieldValues[field.key] ?? ""}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      disabled={isPending}
                      className="font-mono text-xs"
                    />
                  )}
                  {field.helpText && <p className="text-[11px] text-muted-foreground">{field.helpText}</p>}
                </div>
              ))}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button onClick={() => validateMutation.mutate()} disabled={!allFieldsFilled || isPending}>
                {isPending ? (
                  <>
                    <SpinnerGapIcon size={14} className="animate-spin" />
                    {integration.type === "notion" ? "Validating..." : "Connecting..."}
                  </>
                ) : (
                  "Connect"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : step === "clickup-workspaces" ? (
          /* ClickUp: Workspace + space picker */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Select Workspaces
              </DialogTitle>
              <DialogDescription>
                Choose which workspaces and spaces to sync. You can change this later.
              </DialogDescription>
            </DialogHeader>

            <ClickUpWorkspacePicker
              workspaces={clickUpWorkspaces}
              selectedWorkspaceIds={selectedWorkspaceIds}
              selectedSpaceIds={selectedSpaceIds}
              onToggleWorkspace={(id) => {
                setSelectedWorkspaceIds((prev) => {
                  const next = new Set(prev);
                  const ws = clickUpWorkspaces.find((w) => w.id === id);
                  if (next.has(id)) {
                    next.delete(id);
                    // Deselect all spaces in this workspace
                    if (ws) {
                      setSelectedSpaceIds((sp) => {
                        const n = new Set(sp);
                        for (const s of ws.spaces) n.delete(s.id);
                        return n;
                      });
                    }
                  } else {
                    next.add(id);
                    // Select all spaces in this workspace
                    if (ws) {
                      setSelectedSpaceIds((sp) => {
                        const n = new Set(sp);
                        for (const s of ws.spaces) n.add(s.id);
                        return n;
                      });
                    }
                  }
                  return next;
                });
              }}
              onToggleSpace={(id) => {
                setSelectedSpaceIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
              disabled={connectWithClickUpMutation.isPending}
            />

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setStep("credentials")}
                disabled={connectWithClickUpMutation.isPending}
              >
                <ArrowLeftIcon size={14} />
                Back
              </Button>
              <Button
                onClick={() => connectWithClickUpMutation.mutate()}
                disabled={connectWithClickUpMutation.isPending || selectedSpaceIds.size === 0}
              >
                {connectWithClickUpMutation.isPending ? (
                  <>
                    <SpinnerGapIcon size={14} className="animate-spin" />
                    Connecting...
                  </>
                ) : (
                  `Connect ${selectedSpaceIds.size} space${selectedSpaceIds.size === 1 ? "" : "s"}`
                )}
              </Button>
            </DialogFooter>
          </>
        ) : step === "notion-pages" ? (
          /* Notion: Root page picker with live scanning */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Select Pages to Sync
              </DialogTitle>
              <DialogDescription>
                Choose which top-level pages to sync. Only content under selected pages will be indexed.
              </DialogDescription>
            </DialogHeader>

            {/* Scanning status bar */}
            {!notionScanDone && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <SpinnerGapIcon size={14} className="shrink-0 animate-spin" />
                <span>
                  Scanning workspace...{" "}
                  {notionPagesScanned > 0 && `${notionPagesScanned.toLocaleString()} pages scanned`}
                  {notionRootPages.length > 0 && `, ${notionRootPages.length} top-level pages found`}
                </span>
              </div>
            )}

            {notionRootPages.length > 0 ? (
              <NotionRootPagePicker
                pages={notionRootPages}
                selectedIds={selectedNotionPageIds}
                onToggle={toggleNotionPage}
                disabled={connectWithNotionPagesMutation.isPending}
              />
            ) : notionScanDone ? (
              <div className="rounded-lg border border-border bg-muted/20 px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">No top-level pages found.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Make sure you've shared pages with the Notion integration.
                </p>
              </div>
            ) : null}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setNotionBrowseId(null);
                  setStep("credentials");
                }}
                disabled={connectWithNotionPagesMutation.isPending}
              >
                <ArrowLeftIcon size={14} />
                Back
              </Button>
              <Button
                onClick={() => connectWithNotionPagesMutation.mutate()}
                disabled={connectWithNotionPagesMutation.isPending || selectedNotionPageIds.size === 0}
              >
                {connectWithNotionPagesMutation.isPending ? (
                  <>
                    <SpinnerGapIcon size={14} className="animate-spin" />
                    Connecting...
                  </>
                ) : (
                  `Connect ${selectedNotionPageIds.size} page${selectedNotionPageIds.size === 1 ? "" : "s"}`
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          /* Step 2: Shared drive picker or folder picker (Google Drive only) */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                {isMyDriveMode ? "Select Folders" : "Select Shared Drives"}
              </DialogTitle>
              <DialogDescription>
                {isMyDriveMode
                  ? "Choose which folders to sync from your Google Drive. You can change this later."
                  : "Choose which shared drives to sync. You can change this later."}
              </DialogDescription>
            </DialogHeader>

            {isMyDriveMode ? (
              <FolderPicker
                folders={rootFolders}
                selectedIds={selectedFolderIds}
                onToggle={toggleFolder}
                disabled={isPending}
              />
            ) : (
              <SharedDrivePicker
                drives={sharedDrives}
                selectedIds={selectedDriveIds}
                onToggle={toggleDrive}
                disabled={isPending}
              />
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("credentials")} disabled={isPending}>
                <ArrowLeftIcon size={14} />
                Back
              </Button>
              <Button
                onClick={() => connectWithDrivesMutation.mutate()}
                disabled={isPending || (isMyDriveMode ? selectedFolderIds.size === 0 : selectedDriveIds.size === 0)}
              >
                {isPending ? (
                  <>
                    <SpinnerGapIcon size={14} className="animate-spin" />
                    Connecting...
                  </>
                ) : isMyDriveMode ? (
                  `Connect ${selectedFolderIds.size} folder${selectedFolderIds.size === 1 ? "" : "s"}`
                ) : (
                  `Connect ${selectedDriveIds.size} drive${selectedDriveIds.size === 1 ? "" : "s"}`
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Shared drive picker — used in both connect and manage dialogs. */
export function SharedDrivePicker({
  drives,
  selectedIds,
  onToggle,
  disabled,
  connectorId,
}: {
  drives: SharedDrive[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
  connectorId?: string;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (drives.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-6 text-center">
        <FolderIcon size={24} className="mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No shared drives found.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Make sure the service account or OAuth user has access to shared drives.
        </p>
      </div>
    );
  }

  const allSelected = drives.every((d) => selectedIds.has(d.id));

  return (
    <div className="space-y-1.5">
      {/* Select all toggle */}
      <button
        type="button"
        onClick={() => {
          if (allSelected) {
            for (const d of drives) onToggle(d.id);
          } else {
            for (const d of drives) {
              if (!selectedIds.has(d.id)) onToggle(d.id);
            }
          }
        }}
        disabled={disabled}
        className="flex w-full items-center gap-2 px-1 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <span className="inline-flex size-4 items-center justify-center rounded border border-border">
          {allSelected && <span className="size-2 rounded-sm bg-foreground" />}
        </span>
        {allSelected ? "Deselect all" : "Select all"} ({drives.length})
      </button>

      <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-border">
        {drives.map((drive) => {
          const isSelected = selectedIds.has(drive.id);
          const isExpanded = expandedIds.has(drive.id);
          return (
            <div key={drive.id}>
              <div
                className={`flex w-full items-center gap-1 px-1 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                  isSelected ? "bg-muted/30" : ""
                }`}
              >
                {connectorId ? (
                  <button
                    type="button"
                    onClick={() => toggleExpand(drive.id)}
                    className="flex shrink-0 items-center justify-center size-6 rounded hover:bg-muted/80 text-muted-foreground"
                    title="Preview drive contents"
                  >
                    <CaretRightIcon size={12} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                  </button>
                ) : (
                  <span className="size-6 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => onToggle(drive.id)}
                  disabled={disabled}
                  className="flex flex-1 items-center gap-2.5 disabled:opacity-50"
                >
                  <span
                    className={`inline-flex size-4 shrink-0 items-center justify-center rounded border ${
                      isSelected ? "border-primary bg-primary" : "border-border"
                    }`}
                  >
                    {isSelected && (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="size-3 text-primary-foreground"
                        role="img"
                        aria-label="Selected"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  {isExpanded ? (
                    <FolderOpenIcon size={16} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{drive.name}</span>
                </button>
              </div>
              {isExpanded && connectorId && <FolderContents connectorId={connectorId} folderId={drive.id} />}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {selectedIds.size} of {drives.length} drive{drives.length === 1 ? "" : "s"} selected
      </p>
    </div>
  );
}

/** Expandable row showing a folder's children (files and subfolders). */
export function FolderContents({
  connectorId,
  folderId,
}: {
  connectorId: string;
  folderId: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["folder-contents", connectorId, folderId],
    queryFn: () => api.integrations.browseFolderContents(connectorId, folderId),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-1.5 pl-12 text-xs text-muted-foreground">
        <SpinnerGapIcon size={12} className="animate-spin" />
        Loading…
      </div>
    );
  }

  const items = data?.items ?? [];
  if (items.length === 0) {
    return <p className="py-1.5 pl-12 text-xs text-muted-foreground">Empty folder</p>;
  }

  return (
    <div className="border-l border-border/50 ml-5">
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-2 py-1 pl-4 pr-3 text-xs text-muted-foreground">
          {item.isFolder ? <FolderIcon size={14} className="shrink-0" /> : <FileIcon size={14} className="shrink-0" />}
          <span className="truncate">{item.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Folder picker for My Drive mode — selects root-level folders to sync. */
export function FolderPicker({
  folders,
  selectedIds,
  onToggle,
  disabled,
  connectorId,
}: {
  folders: Array<{ id: string; name: string }>;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
  connectorId?: string;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (folders.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-6 text-center">
        <FolderIcon size={24} className="mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No folders found in your Drive.</p>
      </div>
    );
  }

  const allSelected = folders.every((f) => selectedIds.has(f.id));

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => {
          if (allSelected) {
            for (const f of folders) onToggle(f.id);
          } else {
            for (const f of folders) {
              if (!selectedIds.has(f.id)) onToggle(f.id);
            }
          }
        }}
        disabled={disabled}
        className="flex w-full items-center gap-2 px-1 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <span className="inline-flex size-4 items-center justify-center rounded border border-border">
          {allSelected && <span className="size-2 rounded-sm bg-foreground" />}
        </span>
        {allSelected ? "Deselect all" : "Select all"} ({folders.length})
      </button>

      <div className="max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-border">
        {folders.map((folder) => {
          const isSelected = selectedIds.has(folder.id);
          const isExpanded = expandedIds.has(folder.id);
          return (
            <div key={folder.id}>
              <div
                className={`flex w-full items-center gap-1 px-1 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                  isSelected ? "bg-muted/30" : ""
                }`}
              >
                {connectorId ? (
                  <button
                    type="button"
                    onClick={() => toggleExpand(folder.id)}
                    className="flex shrink-0 items-center justify-center size-6 rounded hover:bg-muted/80 text-muted-foreground"
                    title="Preview folder contents"
                  >
                    <CaretRightIcon size={12} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                  </button>
                ) : (
                  <span className="size-6 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => onToggle(folder.id)}
                  disabled={disabled}
                  className="flex flex-1 items-center gap-2.5 disabled:opacity-50"
                >
                  <span
                    className={`inline-flex size-4 shrink-0 items-center justify-center rounded border ${
                      isSelected ? "border-primary bg-primary" : "border-border"
                    }`}
                  >
                    {isSelected && (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="size-3 text-primary-foreground"
                        role="img"
                        aria-label="Selected"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  {isExpanded ? (
                    <FolderOpenIcon size={16} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{folder.name}</span>
                </button>
              </div>
              {isExpanded && connectorId && <FolderContents connectorId={connectorId} folderId={folder.id} />}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {selectedIds.size} of {folders.length} folder{folders.length === 1 ? "" : "s"} selected
      </p>
    </div>
  );
}

/** ClickUp workspace + space picker. Workspaces are top-level, spaces are nested. */
export function ClickUpWorkspacePicker({
  workspaces,
  selectedWorkspaceIds,
  selectedSpaceIds,
  onToggleWorkspace,
  onToggleSpace,
  disabled,
}: {
  workspaces: ClickUpWorkspace[];
  selectedWorkspaceIds: Set<string>;
  selectedSpaceIds: Set<string>;
  onToggleWorkspace: (id: string) => void;
  onToggleSpace: (id: string) => void;
  disabled?: boolean;
}) {
  if (workspaces.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-6 text-center">
        <FolderIcon size={24} className="mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No workspaces found.</p>
      </div>
    );
  }

  const totalSpaces = workspaces.reduce((sum, w) => sum + w.spaces.length, 0);

  return (
    <div className="space-y-1.5">
      <ScopeList>
        {workspaces.map((ws) => (
          <ScopeGroup
            key={ws.id}
            checked={selectedWorkspaceIds.has(ws.id)}
            label={ws.name}
            sublabel={`${ws.memberCount} members`}
            onToggle={() => onToggleWorkspace(ws.id)}
            disabled={disabled}
            defaultExpanded={selectedWorkspaceIds.has(ws.id)}
          >
            {ws.spaces.map((space) => (
              <ScopeSubItem
                key={space.id}
                checked={selectedSpaceIds.has(space.id)}
                label={space.name}
                sublabel={space.private ? "private" : undefined}
                onToggle={() => onToggleSpace(space.id)}
                disabled={disabled}
              />
            ))}
          </ScopeGroup>
        ))}
      </ScopeList>
      <ScopeCount selected={selectedSpaceIds.size} total={totalSpaces} noun="spaces" />
    </div>
  );
}

/** Notion root page picker — select which top-level pages to sync. */
export function NotionRootPagePicker({
  pages,
  selectedIds,
  onToggle,
  disabled,
}: {
  pages: NotionPage[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  if (pages.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-6 text-center">
        <FolderIcon size={24} className="mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No pages found.</p>
        <p className="mt-1 text-xs text-muted-foreground">Make sure you've shared pages with the Notion integration.</p>
      </div>
    );
  }

  const allSelected = pages.every((p) => selectedIds.has(p.id));

  return (
    <div className="space-y-1.5">
      <ScopeSelectAll
        allSelected={allSelected}
        totalCount={pages.length}
        onToggle={() => {
          for (const p of pages) {
            if (allSelected || !selectedIds.has(p.id)) onToggle(p.id);
          }
        }}
        disabled={disabled}
        noun="pages"
      />
      <ScopeList>
        {pages.map((page) => (
          <ScopeItem
            key={page.id}
            checked={selectedIds.has(page.id)}
            label={page.title}
            icon={<FileIcon size={16} className="shrink-0 text-muted-foreground" />}
            onToggle={() => onToggle(page.id)}
            disabled={disabled}
          />
        ))}
      </ScopeList>
      <ScopeCount selected={selectedIds.size} total={pages.length} noun="pages" />
    </div>
  );
}

export function IntegrationIcon({
  color,
  name,
  type,
  size = "sm",
}: { color: string; name: string; type?: string; size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "size-6",
    md: "size-8",
    lg: "size-10",
  };

  const logoSizes = { sm: 12, md: 16, lg: 20 };
  const fontSizes = { sm: "text-[11px]", md: "text-xs", lg: "text-sm" };

  const logo = type ? <ConnectorLogo type={type} size={logoSizes[size]} className="text-white" /> : null;

  return (
    <div
      className={`${sizeClasses[size]} flex items-center justify-center rounded-md font-semibold text-white`}
      style={{ backgroundColor: color }}
    >
      {logo || <span className={fontSizes[size]}>{name[0]}</span>}
    </div>
  );
}
