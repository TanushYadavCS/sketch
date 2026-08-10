/**
 * Generic connect dialog for integrations.
 * Reads auth fields and connect steps from the integration registry,
 * so adding a new integration requires zero dialog changes.
 *
 * OAuth redirect connectors use this flow:
 * 1. Admin configures client_id + client_secret when provider setup is required
 * 2. The user redirects to the provider's consent screen
 * 3. Callback auto-creates connector and triggers sync
 *
 * Other integrations connect immediately after credential validation.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import {
  GenericScopePicker,
  ScopeCount,
  ScopeGroup,
  ScopeItem,
  ScopeList,
  ScopeSelectAll,
  ScopeSubItem,
  buildScopeFromSelection,
  computeSelectedFromScope,
} from "@/components/scope-picker";
import { type BrowseResult, api } from "@/lib/api";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
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

type BrowseResultWithScope = BrowseResult & { scopeConfig?: Record<string, unknown> };

interface ConnectIntegrationDialogProps {
  integration: IntegrationDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
  preferCanvasCredentialSource?: boolean;
  canvasConnectionReady?: boolean;
  canvasAccountId?: string | null;
  canvasConnectionLookupPending?: boolean;
  onCanvasConnectionStarted?: () => void;
}

export function ConnectIntegrationDialog({
  integration,
  open,
  onOpenChange,
  onConnected,
  preferCanvasCredentialSource = false,
  canvasConnectionReady = false,
  canvasAccountId = null,
  canvasConnectionLookupPending = false,
  onCanvasConnectionStarted,
}: ConnectIntegrationDialogProps) {
  const auth = useDashboardAuth();
  const isAdmin = auth.role === "admin";
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  // Zoho CRM (and any future multi-DC OAuth connector) picks a data center first.
  const [region, setRegion] = useState<string>("com");

  // OAuth state
  const [step, setStep] = useState<
    "credentials" | "drives" | "notion-pages" | "clickup-workspaces" | "generic-scope" | "oauth-config"
  >("credentials");
  const [manualOAuthConfigOpen, setManualOAuthConfigOpen] = useState(false);
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
  const [managedConnectorId, setManagedConnectorId] = useState<string | null>(null);
  const [canvasPopupOpened, setCanvasPopupOpened] = useState(false);
  const [autoCanvasImportStarted, setAutoCanvasImportStarted] = useState(false);
  const [genericBrowseData, setGenericBrowseData] = useState<BrowseResult | null>(null);
  const [selectedGenericIds, setSelectedGenericIds] = useState<Set<string>>(new Set());

  const isOAuthRedirect = integration?.oauthRedirect === true;
  const isZoho = integration?.type === "zoho_crm";
  const isMicrosoft =
    integration?.type === "outlook" || integration?.type === "outlook_calendar" || integration?.type === "teams";
  const canvasSupported =
    integration?.type === "google_drive" ||
    integration?.type === "google_calendar" ||
    integration?.type === "gmail" ||
    integration?.type === "outlook" ||
    integration?.type === "outlook_calendar" ||
    integration?.type === "teams" ||
    integration?.type === "fireflies" ||
    integration?.type === "clickup" ||
    integration?.type === "notion" ||
    integration?.type === "linear";
  const oauthProviderName = isMicrosoft ? "Microsoft" : "Google";
  const oauthCredentialConsoleLabel = isMicrosoft ? "Microsoft Entra" : "Google Cloud Console";
  const oauthCallbackPath = isMicrosoft ? "/api/oauth/microsoft/callback" : "/api/oauth/google/callback";

  const credentialSource = useQuery({
    queryKey: ["connector-credential-source"],
    queryFn: () => api.integrations.credentialSource(),
    enabled: open,
  });
  const isCanvasMode = credentialSource.data?.mode === "canvas" && canvasSupported;
  const useCanvasCredentialFlow =
    canvasSupported &&
    (!credentialSource.isSuccess || isCanvasMode || preferCanvasCredentialSource || canvasConnectionLookupPending);
  const canvasCredentialImportConfigured = credentialSource.data?.canvasCredentialImportConfigured !== false;
  const canvasConnectionCanImport = canvasConnectionReady;
  const shouldAutoImportCanvasCredential = canvasConnectionReady && useCanvasCredentialFlow;
  const waitingForCanvasConnectionLookup =
    useCanvasCredentialFlow &&
    !credentialSource.isError &&
    (!credentialSource.isSuccess || canvasConnectionLookupPending) &&
    !canvasConnectionReady &&
    !canvasPopupOpened;
  const waitingForCanvasConnectionCompletion = useCanvasCredentialFlow && canvasPopupOpened && !canvasConnectionReady;

  useEffect(() => {
    if (!open) setAutoCanvasImportStarted(false);
  }, [open]);

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

  // Check if the provider's OAuth is configured (for OAuth redirect integrations)
  const oauthStatus = useQuery({
    queryKey: [isZoho ? "zoho-oauth-status" : isMicrosoft ? "microsoft-oauth-status" : "google-oauth-status"],
    queryFn: () =>
      isZoho ? api.zohoOAuth.status() : isMicrosoft ? api.microsoftOAuth.status() : api.googleOAuth.status(),
    enabled: open && isOAuthRedirect && !useCanvasCredentialFlow && !canvasConnectionLookupPending,
  });

  const isOAuthConfigured = oauthStatus.data?.configured === true;
  const microsoftUsesEnvClient =
    isMicrosoft &&
    oauthStatus.data !== undefined &&
    "envConfigured" in oauthStatus.data &&
    oauthStatus.data.envConfigured === true &&
    (!("settingsConfigured" in oauthStatus.data) || oauthStatus.data.settingsConfigured !== true);
  const needsClientSetup = integration?.requiresOAuthClientSetup === true || (isMicrosoft && !microsoftUsesEnvClient);

  // For OAuth redirect: start with oauth-config step if client setup is required and missing.
  useEffect(() => {
    if (open && useCanvasCredentialFlow) {
      setStep("credentials");
      setManualOAuthConfigOpen(false);
      return;
    }
    if (open && isOAuthRedirect) {
      if (oauthStatus.isSuccess) {
        if (manualOAuthConfigOpen) {
          setStep("oauth-config");
          return;
        }
        setStep(needsClientSetup && !isOAuthConfigured ? "oauth-config" : "credentials");
      }
    }
  }, [
    open,
    useCanvasCredentialFlow,
    isOAuthRedirect,
    oauthStatus.isSuccess,
    isOAuthConfigured,
    needsClientSetup,
    manualOAuthConfigOpen,
  ]);

  useEffect(() => {
    if (!open || step !== "oauth-config" || !oauthStatus.isSuccess || !isOAuthConfigured) return;
    setFieldValues((prev) => {
      const next = { ...prev };
      const tenant =
        oauthStatus.data && "tenant" in oauthStatus.data && typeof oauthStatus.data.tenant === "string"
          ? oauthStatus.data.tenant
          : null;
      if (!next.client_id && oauthStatus.data?.clientId) next.client_id = oauthStatus.data.clientId;
      if (!next.tenant && isMicrosoft && tenant) next.tenant = tenant;
      return next;
    });
  }, [open, step, oauthStatus.isSuccess, oauthStatus.data, isMicrosoft, isOAuthConfigured]);

  /** Save provider OAuth client_id + client_secret. */
  const configureOAuthMutation = useMutation({
    mutationFn: async () => {
      const clientId = fieldValues.client_id?.trim();
      const clientSecret = fieldValues.client_secret?.trim();
      if (isMicrosoft) {
        if (!clientId || !clientSecret) throw new Error("Application (client) ID and Client Secret are required");
        const tenant = fieldValues.tenant?.trim();
        if (!tenant) throw new Error("Directory (tenant) ID is required");
        await api.microsoftOAuth.configure(clientId, clientSecret, tenant);
      } else {
        if (!clientId || !clientSecret) throw new Error("Client ID and Secret are required");
        await api.googleOAuth.configure(clientId, clientSecret);
      }
    },
    onSuccess: () => {
      toast.success(`${oauthProviderName} OAuth configured.`);
      oauthStatus.refetch();
      setManualOAuthConfigOpen(false);
      setStep("credentials");
    },
    onError: (error: Error) => {
      toast.error(error.message || `Failed to configure ${oauthProviderName} OAuth.`);
    },
  });

  /** For non-OAuth-redirect integrations: connect directly (or browse scope first). */
  const validateMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      if (useCanvasCredentialFlow && managedConnectorId) {
        return api.integrations.updateScope(managedConnectorId, { rootPages: Array.from(selectedNotionPageIds) });
      }
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

      if (integration.authType === "system" && integration.scopeType === "flat") {
        const scopeConfig = {
          [integration.scopeConfigKey ?? "rootPages"]: integration.flatScopeShape === "map" ? {} : [],
        };
        const result = await api.integrations.connect({
          connectorType: integration.type,
          authType: integration.authType,
          credentials,
          scopeConfig,
        });
        setManagedConnectorId(result.connector.id);
        const browseResult = await api.integrations.browseExisting(result.connector.id);
        if (browseResult.type === "flat") {
          const scopedResult = browseResult as BrowseResultWithScope;
          setGenericBrowseData(browseResult);
          setSelectedGenericIds(
            computeSelectedFromScope(
              scopedResult,
              scopedResult.scopeConfig ?? scopeConfig,
              integration.scopeConfigKey,
              integration.flatScopeShape,
            ),
          );
          setStep("generic-scope");
          return { deferredScope: true };
        }
        throw new Error("Scope browsing is not available for this connector.");
      }

      await api.integrations.connect({
        connectorType: integration.type,
        authType: integration.authType,
        credentials,
      });
    },
    onSuccess: (result) => {
      if (result && typeof result === "object" && "deferredScope" in result) return;
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
      if (useCanvasCredentialFlow && managedConnectorId) {
        return api.integrations.updateScope(managedConnectorId, { rootPages: Array.from(selectedNotionPageIds) });
      }
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
      const scopeConfig = {
        workspaces: Array.from(selectedWorkspaceIds),
        spaces: Array.from(selectedSpaceIds),
      };
      if (useCanvasCredentialFlow && managedConnectorId) {
        return api.integrations.updateScope(managedConnectorId, scopeConfig);
      }
      const credentials = buildCredentials();
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

  const connectWithGenericScopeMutation = useMutation({
    mutationFn: async () => {
      if (!integration || !genericBrowseData) throw new Error("No scope selection available");
      const scopeConfig = buildScopeFromSelection(
        genericBrowseData,
        selectedGenericIds,
        integration.scopeConfigKey,
        integration.flatScopeShape,
      );
      if (useCanvasCredentialFlow || managedConnectorId) {
        if (!managedConnectorId) throw new Error("No managed connector selected");
        return api.integrations.updateScope(managedConnectorId, scopeConfig);
      }
      const credentials = buildCredentials();
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
      const scopeConfig =
        sharedDrives.length > 0
          ? { sharedDrives: Array.from(selectedDriveIds) }
          : { folders: Array.from(selectedFolderIds) };
      if (useCanvasCredentialFlow && managedConnectorId) {
        return api.integrations.updateScope(managedConnectorId, scopeConfig);
      }
      const credentials = buildCredentials();
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
    setManagedConnectorId(null);
    setCanvasPopupOpened(false);
    setManualOAuthConfigOpen(false);
    setGenericBrowseData(null);
    setSelectedGenericIds(new Set());
    onOpenChange(false);
  };

  const closeSystemConnectorAfterCreate = () => {
    resetAndClose();
    onConnected();
  };

  const canvasConnectMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      const result = await api.integrations.canvasConnect({
        connectorType: integration.type,
        callbackUrl: window.location.href,
      });
      const popup = window.open(result.redirectUrl, "canvas-connect", "width=640,height=760");
      if (!popup || popup.closed) {
        throw new Error("Popup blocked. Allow popups for this site, then try again.");
      }
      setCanvasPopupOpened(true);
      onCanvasConnectionStarted?.();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to start account connection.");
    },
  });

  const canvasImportMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error("No integration selected");
      return api.integrations.canvasImport({
        connectorType: integration.type,
        ...(canvasAccountId ? { accountId: canvasAccountId } : {}),
      });
    },
    onSuccess: async ({ connector }) => {
      if (!integration) return;
      setManagedConnectorId(connector.id);

      if (integration.type === "google_drive") {
        const result = await api.integrations.browseGoogleDriveExisting(connector.id);
        setSharedDrives(result.sharedDrives);
        setRootFolders(result.rootFolders);
        setSelectedDriveIds(new Set(result.sharedDrives.filter((d) => d.selected).map((d) => d.id)));
        setSelectedFolderIds(new Set(result.rootFolders.filter((f) => f.selected).map((f) => f.id)));
        setStep("drives");
        return;
      }

      if (integration.type === "clickup") {
        const result = await api.integrations.browseClickUpExisting(connector.id);
        setClickUpWorkspaces(result.workspaces);
        setSelectedWorkspaceIds(new Set(result.workspaces.filter((w) => w.selected).map((w) => w.id)));
        setSelectedSpaceIds(
          new Set(result.workspaces.flatMap((w) => w.spaces.filter((s) => s.selected).map((s) => s.id))),
        );
        setStep("clickup-workspaces");
        return;
      }

      if (integration.type === "notion") {
        const result = await api.integrations.browseNotionExisting(connector.id);
        setNotionRootPages(result.rootPages.map((p) => ({ id: p.id, title: p.title, url: p.url })));
        setSelectedNotionPageIds(new Set(result.rootPages.filter((p) => p.selected).map((p) => p.id)));
        setNotionScanDone(true);
        setStep("notion-pages");
        return;
      }

      if (integration.scopeType === "flat") {
        const result = await api.integrations.browseExisting(connector.id);
        if (result.type === "flat") {
          const scopedResult = result as BrowseResultWithScope;
          setGenericBrowseData(result);
          setSelectedGenericIds(
            computeSelectedFromScope(
              scopedResult,
              scopedResult.scopeConfig ?? {},
              integration.scopeConfigKey,
              integration.flatScopeShape,
            ),
          );
          setStep("generic-scope");
          return;
        }
      }

      toast.success(`${integration.name} connected successfully.`);
      resetAndClose();
      onConnected();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to set up the connected account.");
    },
  });

  useEffect(() => {
    if (!open || !shouldAutoImportCanvasCredential || autoCanvasImportStarted || canvasImportMutation.isPending) return;
    if (!credentialSource.isSuccess) return;
    if (
      !canvasConnectionCanImport ||
      credentialSource.data?.canvasConfigured === false ||
      !canvasCredentialImportConfigured
    ) {
      return;
    }

    setAutoCanvasImportStarted(true);
    canvasImportMutation.mutate();
  }, [
    open,
    shouldAutoImportCanvasCredential,
    autoCanvasImportStarted,
    canvasImportMutation,
    credentialSource.isSuccess,
    credentialSource.data?.canvasConfigured,
    canvasConnectionCanImport,
    canvasCredentialImportConfigured,
  ]);

  const autoCanvasImportErrorMessage = credentialSource.isError
    ? "Sketch could not check the connected-account setup."
    : credentialSource.data?.canvasConfigured === false
      ? "The connected-account provider is not configured."
      : !canvasCredentialImportConfigured
        ? "Connected-account import is not configured for this workspace."
        : canvasImportMutation.isError
          ? "Sketch could not set up the connected account."
          : null;

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

  const handleConnectWithZoho = () => {
    const url = api.zohoOAuth.authorizeUrl(region);
    window.open(url, "_self");
  };

  const handleConnectWithMicrosoft = () => {
    window.open(api.microsoftOAuth.authorizeUrl(integration?.type), "_self");
  };

  const handleGrantMicrosoftAdminConsent = () => {
    if (!integration?.type) return;
    window.open(api.microsoftOAuth.adminConsentUrl(integration.type), "_self");
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
    connectWithGenericScopeMutation.isPending ||
    canvasConnectMutation.isPending ||
    canvasImportMutation.isPending ||
    configureOAuthMutation.isPending;

  if (!integration) return null;

  const isMyDriveMode = sharedDrives.length === 0;
  const oauthRedirectUri = `${oauthStatus.data?.baseUrl || window.location.origin}${oauthCallbackPath}`;
  const oauthClientSetupSteps = integration.oauthClientSetupSteps ?? integration.connectSteps;
  const oauthClientCredentialUrl = integration.oauthClientCredentialUrl ?? integration.credentialUrl;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && integration.authType === "system" && managedConnectorId) closeSystemConnectorAfterCreate();
        else if (!next) resetAndClose();
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
                One-time setup: enter your {oauthProviderName} OAuth credentials. After this, users can connect with one
                click.
              </DialogDescription>
            </DialogHeader>

            <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
              {oauthClientSetupSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <a href={oauthClientCredentialUrl} target="_blank" rel="noopener noreferrer">
                  {oauthCredentialConsoleLabel}
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
                <strong>Redirect URI</strong> — add this to your {oauthProviderName} OAuth client's redirect URIs:
              </p>
              <code className="mt-1 block text-[11px] text-foreground">{oauthRedirectUri}</code>
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
        ) : step === "credentials" && useCanvasCredentialFlow && shouldAutoImportCanvasCredential ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Add {integration.name} to Sketch
              </DialogTitle>
              <DialogDescription>Sketch is using the account you already connected.</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col items-center gap-3 py-8 text-center">
              {autoCanvasImportErrorMessage ? (
                <>
                  <p className="text-sm font-medium">Could not add {integration.name}</p>
                  <p className="max-w-sm text-sm text-muted-foreground">{autoCanvasImportErrorMessage}</p>
                </>
              ) : (
                <>
                  <SpinnerGapIcon size={22} className="animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Setting up Sketch sync...</p>
                </>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={resetAndClose}>
                Close
              </Button>
              {(credentialSource.isError || canvasImportMutation.isError) && (
                <Button
                  onClick={() => {
                    canvasImportMutation.reset();
                    setAutoCanvasImportStarted(false);
                    if (credentialSource.isError) void credentialSource.refetch();
                  }}
                >
                  Try again
                </Button>
              )}
            </DialogFooter>
          </>
        ) : step === "credentials" && useCanvasCredentialFlow ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Connect {integration.name}
              </DialogTitle>
              <DialogDescription>
                {waitingForCanvasConnectionLookup
                  ? "Checking for an account you already connected."
                  : waitingForCanvasConnectionCompletion
                    ? "Finish signing in in the popup. Sketch will continue automatically."
                    : canvasConnectionReady
                      ? "Sketch will use the account you already connected, then let you choose what to sync."
                      : "Connect your account, then choose what Sketch should sync."}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3 py-4">
              {credentialSource.isError ? (
                <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
                  <p>Sketch could not check the connected-account setup.</p>
                  <Button variant="outline" onClick={() => void credentialSource.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : waitingForCanvasConnectionLookup || waitingForCanvasConnectionCompletion ? (
                <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
                  <SpinnerGapIcon size={16} className="animate-spin" />
                  {waitingForCanvasConnectionCompletion
                    ? "Waiting for sign-in to finish..."
                    : "Checking connected accounts..."}
                </div>
              ) : (
                <>
                  {!canvasConnectionReady && (
                    <Button
                      size="lg"
                      className="w-full"
                      onClick={() => canvasConnectMutation.mutate()}
                      disabled={isPending || credentialSource.data?.canvasConfigured === false}
                    >
                      {canvasConnectMutation.isPending ? (
                        <>
                          <SpinnerGapIcon size={14} className="animate-spin" />
                          Opening account connection...
                        </>
                      ) : (
                        "Connect account"
                      )}
                    </Button>
                  )}
                  {canvasConnectionCanImport && (
                    <Button
                      variant={canvasConnectionReady ? "default" : "outline"}
                      className="w-full"
                      onClick={() => canvasImportMutation.mutate()}
                      disabled={
                        isPending ||
                        credentialSource.data?.canvasConfigured === false ||
                        !canvasCredentialImportConfigured
                      }
                    >
                      {canvasImportMutation.isPending ? (
                        <>
                          <SpinnerGapIcon size={14} className="animate-spin" />
                          Setting up...
                        </>
                      ) : (
                        "Set up Sketch sync"
                      )}
                    </Button>
                  )}
                </>
              )}
              {credentialSource.data?.canvasConfigured === false && (
                <p className="text-center text-xs text-muted-foreground">
                  The connected-account provider is not configured.
                </p>
              )}
              {!canvasCredentialImportConfigured && credentialSource.data?.canvasConfigured !== false && (
                <p className="text-center text-xs text-muted-foreground">
                  Connected-account import is not configured for this workspace.
                </p>
              )}
            </div>
          </>
        ) : step === "credentials" && isOAuthRedirect && isZoho ? (
          /* OAuth redirect (Zoho): data-center picker + connect button */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Connect {integration.name}
              </DialogTitle>
              <DialogDescription>
                Choose your Zoho data center, then sign in to authorize read-only access to your CRM.
              </DialogDescription>
            </DialogHeader>

            <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
              {integration.connectSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>

            <div className="space-y-1.5">
              <Label htmlFor="zoho-region" className="text-xs">
                Data center
              </Label>
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger id="zoho-region">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(integration.regionOptions ?? []).map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Match the domain of your Zoho CRM URL (e.g. crm.zoho.com → United States).
              </p>
            </div>

            {isOAuthConfigured ? (
              <Button size="lg" className="w-full gap-2" onClick={handleConnectWithZoho}>
                <ConnectorLogo type="zoho_crm" size={16} className="text-white" />
                Connect with Zoho
              </Button>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                Zoho OAuth isn't configured on the server yet. Set <code>ZOHO_CLIENT_ID</code> and{" "}
                <code>ZOHO_CLIENT_SECRET</code> in the environment, then reload.
              </div>
            )}
          </>
        ) : step === "credentials" && isOAuthRedirect && isMicrosoft ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Connect {integration.name}
              </DialogTitle>
              <DialogDescription>
                Sign in with your Microsoft account to authorize read-only access to {integration.name}.
              </DialogDescription>
            </DialogHeader>

            <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
              {integration.connectSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>

            {isOAuthConfigured ? (
              <>
                <Button size="lg" className="w-full gap-2" onClick={handleConnectWithMicrosoft}>
                  <ConnectorLogo type={integration.type} size={16} className="text-white" />
                  Connect with Microsoft
                </Button>
                {isMicrosoft && (
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                    Teammates seeing a "needs admin approval" error? A Microsoft admin can{" "}
                    <button
                      type="button"
                      onClick={handleGrantMicrosoftAdminConsent}
                      className="font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      grant admin consent for your organization
                    </button>{" "}
                    once so everyone can connect.
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                Microsoft OAuth isn't configured on the server yet. Set <code>MICROSOFT_CLIENT_ID</code> and{" "}
                <code>MICROSOFT_CLIENT_SECRET</code> in the environment or configure the Microsoft OAuth client in
                settings.
              </div>
            )}

            {isAdmin && needsClientSetup && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setManualOAuthConfigOpen(true);
                    setStep("oauth-config");
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Reconfigure OAuth
                </button>
              </div>
            )}
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
                Sign in with your Google account to authorize read-only access to {integration.name}.
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
                  onClick={() => {
                    setManualOAuthConfigOpen(true);
                    setStep("oauth-config");
                  }}
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

            {integration.credentialUrl && (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" asChild>
                  <a href={integration.credentialUrl} target="_blank" rel="noopener noreferrer">
                    Get credentials
                    <ArrowSquareOutIcon className="size-3.5" />
                  </a>
                </Button>
              </div>
            )}

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
        ) : step === "generic-scope" && genericBrowseData ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <IntegrationIcon color={integration.color} name={integration.name} type={integration.type} />
                Select {integration.scopeItemNoun ?? integration.scopeLabel}
              </DialogTitle>
              <DialogDescription>Choose what to sync. You can change this later.</DialogDescription>
            </DialogHeader>

            <GenericScopePicker
              data={genericBrowseData}
              selectedIds={selectedGenericIds}
              onToggle={(id) => {
                setSelectedGenericIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
              disabled={connectWithGenericScopeMutation.isPending}
              noun={integration.scopeItemNoun ?? "items"}
            />

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  if (integration.authType === "system" && managedConnectorId) {
                    closeSystemConnectorAfterCreate();
                    return;
                  }
                  setStep("credentials");
                }}
                disabled={connectWithGenericScopeMutation.isPending}
              >
                {integration.authType === "system" && managedConnectorId ? null : <ArrowLeftIcon size={14} />}
                {integration.authType === "system" && managedConnectorId ? "Close" : "Back"}
              </Button>
              <Button
                onClick={() => connectWithGenericScopeMutation.mutate()}
                disabled={
                  connectWithGenericScopeMutation.isPending ||
                  (integration.allowEmptyScopeSelection !== true && selectedGenericIds.size === 0)
                }
              >
                {connectWithGenericScopeMutation.isPending ? (
                  <>
                    <SpinnerGapIcon size={14} className="animate-spin" />
                    Connecting...
                  </>
                ) : (
                  `Connect ${selectedGenericIds.size} ${integration.scopeItemNoun ?? "items"}`
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
