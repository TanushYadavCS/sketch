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
import { api } from "@/lib/api";
import type { IntegrationDefinition } from "@/lib/integrations";
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
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  // Google Drive OAuth state
  const [step, setStep] = useState<"credentials" | "drives" | "oauth-config">("credentials");
  const [sharedDrives, setSharedDrives] = useState<SharedDrive[]>([]);
  const [selectedDriveIds, setSelectedDriveIds] = useState<Set<string>>(new Set());
  const [rootFolders, setRootFolders] = useState<SharedDrive[]>([]);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());

  const isOAuthRedirect = integration?.oauthRedirect === true;

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

  /** For non-OAuth-redirect integrations: connect directly. */
  const validateMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      const credentials = buildCredentials();
      await api.integrations.connect({
        connectorType: integration.type,
        authType: integration.authType,
        credentials,
      });
    },
    onSuccess: () => {
      toast.success(`${integration?.name} connected successfully.`);
      resetAndClose();
      onConnected();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to connect. Check your credentials and try again.");
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
    const url = api.googleOAuth.authorizeUrl();
    window.open(url, "_self");
  };

  const allFieldsFilled = integration?.authFields.every((f) => (fieldValues[f.key] ?? "").trim().length > 0) ?? false;
  const isPending =
    validateMutation.isPending || connectWithDrivesMutation.isPending || configureOAuthMutation.isPending;

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
        {step === "oauth-config" ? (
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
                You'll be redirected to Google to authorize read-only access to your Drive.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setStep("oauth-config")}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Reconfigure OAuth
              </button>
            </div>
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
                    Connecting...
                  </>
                ) : (
                  "Connect"
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
