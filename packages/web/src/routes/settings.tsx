import { api } from "@/lib/api";
import {
  CopySimpleIcon,
  DesktopIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Switch } from "@sketch/ui/components/switch";
import { Textarea } from "@sketch/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { dashboardRoute, useDashboardAuth } from "./dashboard";

const MASKED_VALUE = "********************************";

export const settingsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/settings",
  component: SettingsPage,
});

function SettingsPage() {
  const auth = useDashboardAuth();

  if (auth.role !== "admin") {
    return (
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">Manage your personal Sketch settings.</p>
        <div className="mt-6 space-y-8">
          <LocalDevicesSection />
          <ApiTokensSection />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <h1 className="text-xl font-semibold text-foreground">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">Manage workspace-level configuration.</p>

      <div className="mt-6 space-y-8">
        <OrgContextSection />
        <LocalDevicesSection />
        <AccessSection />
        <ApiKeySection />
        <ApiTokensSection />
      </div>
    </div>
  );
}

function OrgContextSection() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery({
    queryKey: ["settings", "identity"],
    queryFn: () => api.settings.identity(),
  });

  const [orgName, setOrgName] = useState("");
  const [description, setDescription] = useState("");
  const [initialised, setInitialised] = useState(false);

  if (!initialised && identityQuery.data) {
    setOrgName(identityQuery.data.orgName ?? "");
    setDescription(identityQuery.data.orgContext?.description ?? "");
    setInitialised(true);
  }

  const saveMutation = useMutation({
    mutationFn: (payload: { orgName: string; description: string }) =>
      api.settings.updateIdentity({
        orgName: payload.orgName,
        orgContext: { description: payload.description },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "identity"] });
      toast.success("Saved");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const trimmedName = orgName.trim();
  const trimmedDescription = description.trim();
  const initialName = identityQuery.data?.orgName ?? "";
  const initialDescription = identityQuery.data?.orgContext?.description ?? "";
  const dirty = trimmedName !== initialName.trim() || trimmedDescription !== initialDescription.trim();
  const canSave = dirty && trimmedName.length > 0 && trimmedDescription.length <= 2000;

  return (
    <section>
      <p className="mb-3 text-sm font-medium text-muted-foreground">Company profile</p>
      {identityQuery.isLoading ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <label htmlFor="org-name" className="text-sm font-medium">
            Company name
          </label>
          <Input
            id="org-name"
            className="mt-1.5 h-9"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Canvas Labs"
          />

          <label htmlFor="org-description" className="mt-4 block text-sm font-medium">
            Company description
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Tell Sketch what your company does — what you build, who you serve, and any flagship products. A paragraph
            is fine. This is used to recognise the right companies and projects when reading your files, and to ground
            Sketch's responses in chat.
          </p>
          <Textarea
            id="org-description"
            className="mt-2 min-h-32"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Canvas Labs is an AI services company working with multiple clients to ship custom AI products. We also build Sketch, an AI assistant for organisations."
            maxLength={2000}
          />
          <div className="mt-1.5 text-right text-xs text-muted-foreground">{trimmedDescription.length} / 2000</div>

          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate({ orgName: trimmedName, description: trimmedDescription })}
              disabled={!canSave || saveMutation.isPending}
            >
              {saveMutation.isPending ? <SpinnerGapIcon size={14} className="animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function LocalDevicesSection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("My Mac");
  const [createdDevice, setCreatedDevice] = useState<{ plaintext: string; baseUrl: string } | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const devicesQuery = useQuery({
    queryKey: ["local-devices"],
    queryFn: () => api.localDevices.list(),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { name: string }) => api.localDevices.create({ ...payload, platform: "macos" }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["local-devices"] });
      setCreatedDevice({ plaintext: result.plaintext, baseUrl: result.baseUrl });
      toast.success("Local device token created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.localDevices.revoke(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["local-devices"] });
      setConfirmRevokeId(null);
      toast.success("Local device revoked");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const trimmedName = name.trim();
  const activeDevices = (devicesQuery.data?.devices ?? []).filter((device) => !device.revokedAt);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">Local Mac</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9"
            maxLength={120}
            aria-label="Local device name"
          />
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => createMutation.mutate({ name: trimmedName })}
            disabled={trimmedName.length === 0 || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <SpinnerGapIcon size={14} className="animate-spin" />
            ) : (
              <DesktopIcon size={14} />
            )}
            Pair Mac
          </Button>
        </div>

        {createdDevice ? (
          <div className="mt-4 rounded-md border border-brand-accent bg-brand-accent/[0.05] p-3">
            <p className="text-sm font-medium">Sketch Local setup</p>
            <div className="mt-2 grid gap-2">
              <div className="grid gap-1.5">
                <label htmlFor="local-device-sketch-domain" className="text-xs font-medium text-muted-foreground">
                  Sketch Domain
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="local-device-sketch-domain"
                    value={createdDevice.baseUrl}
                    readOnly
                    className="h-9 font-mono text-xs"
                    aria-label="Sketch domain"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      copyTextToClipboard(createdDevice.baseUrl).then(() => toast.success("Sketch domain copied"))
                    }
                    aria-label="Copy Sketch domain"
                  >
                    <CopySimpleIcon size={16} />
                  </Button>
                </div>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="local-device-token" className="text-xs font-medium text-muted-foreground">
                  Device token
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="local-device-token"
                    value={createdDevice.plaintext}
                    readOnly
                    className="h-9 font-mono text-xs"
                    aria-label="Device token"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      copyTextToClipboard(createdDevice.plaintext).then(() => toast.success("Token copied"))
                    }
                    aria-label="Copy device token"
                  >
                    <CopySimpleIcon size={16} />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-md border border-border">
          {devicesQuery.isLoading ? (
            <Skeleton className="h-28 rounded-none" />
          ) : activeDevices.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">No paired Macs</div>
          ) : (
            <div className="divide-y divide-border">
              {activeDevices.map((device) => (
                <div key={device.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{device.name}</p>
                      <span
                        className={
                          device.status === "online"
                            ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700"
                            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        }
                      >
                        {device.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {device.prefix}... · Created {formatDate(device.createdAt)}
                      {device.lastSeenAt ? ` · Last seen ${formatDate(device.lastSeenAt)}` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 hover:text-destructive"
                    onClick={() => setConfirmRevokeId(device.id)}
                    aria-label={`Revoke ${device.name}`}
                  >
                    <TrashIcon size={16} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={confirmRevokeId !== null} onOpenChange={(open) => !open && setConfirmRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke local Mac?</AlertDialogTitle>
            <AlertDialogDescription>
              This Mac will disconnect and local commands will stop working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirmRevokeId && revokeMutation.mutate(confirmRevokeId)}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Revoking...
                </>
              ) : (
                "Revoke"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function AccessSection() {
  const queryClient = useQueryClient();
  const accessQuery = useQuery({
    queryKey: ["settings", "access"],
    queryFn: () => api.settings.access(),
  });

  const updateMutation = useMutation({
    mutationFn: (value: boolean) => api.settings.updateAccess({ adminCanReadAllFiles: value }),
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey: ["settings", "access"] });
      const previous = queryClient.getQueryData<{ adminCanReadAllFiles: boolean }>(["settings", "access"]);
      queryClient.setQueryData(["settings", "access"], { adminCanReadAllFiles: value });
      return { previous };
    },
    onError: (err: Error, _value, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["settings", "access"], ctx.previous);
      toast.error(err.message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "access"] });
      toast.success("Saved");
    },
  });

  const value = accessQuery.data?.adminCanReadAllFiles ?? false;

  return (
    <section>
      <p className="mb-3 text-sm font-medium text-muted-foreground">Access</p>
      {accessQuery.isLoading ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-4">
          <div>
            <p className="text-sm font-medium">Admins can read all file content</p>
            <p className="mt-1 text-xs text-muted-foreground">
              When off, admins manage connectors and see file metadata but not file content unless explicitly shared.
              When on, admins can read any file's content. The agent's file-content tool stays on email rails either
              way.
            </p>
          </div>
          <Switch
            checked={value}
            onCheckedChange={(next) => updateMutation.mutate(next)}
            disabled={updateMutation.isPending}
            aria-label="Allow admins to read all file content"
          />
        </div>
      )}
    </section>
  );
}

function ApiKeySection() {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const keyQuery = useQuery({
    queryKey: ["settings", "api-key"],
    queryFn: () => api.settings.apiKey(),
  });

  const generateMutation = useMutation({
    mutationFn: () => api.settings.generateApiKey(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "api-key"] });
      setRevealed(true);
      toast.success("API key generated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: () => api.settings.revokeApiKey(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "api-key"] });
      setRevealed(false);
      setConfirmRevoke(false);
      toast.success("API key revoked");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const apiKey = keyQuery.data?.apiKey ?? "";
  const configured = keyQuery.data?.configured === true;
  const isBusy = generateMutation.isPending || revokeMutation.isPending;

  const handleCopy = async () => {
    if (!apiKey) return;
    try {
      await copyTextToClipboard(apiKey);
      setCopied(true);
      toast.success("API key copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Unable to copy API key");
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">API access</p>
        {configured ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 hover:bg-brand-accent/8"
            onClick={() => setConfirmRegenerate(true)}
            disabled={isBusy}
          >
            <KeyIcon size={14} weight="bold" />
            Regenerate
          </Button>
        ) : null}
      </div>

      {keyQuery.isLoading ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : !configured ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-brand-accent/[0.04] px-6 pt-8 pb-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-brand-accent bg-white">
            <KeyIcon size={24} className="text-[#8B7A00]" />
          </div>
          <p className="mt-3 text-sm font-medium">No API key generated</p>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            Generate a key for trusted systems that need to invoke Sketch through the API.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-4 gap-1.5 hover:bg-brand-accent/8"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending ? <SpinnerGapIcon size={14} className="animate-spin" /> : <KeyIcon size={14} />}
            Generate key
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <Input
              value={revealed ? apiKey : MASKED_VALUE}
              readOnly
              className="h-9 flex-1 font-mono text-xs"
              aria-label="Sketch API key"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setRevealed((current) => !current)}
              aria-label={revealed ? "Hide API key" : "Reveal API key"}
            >
              {revealed ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={handleCopy} aria-label="Copy API key">
              {copied ? <span className="text-[10px] font-medium">OK</span> : <CopySimpleIcon size={16} />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="hover:text-destructive"
              onClick={() => setConfirmRevoke(true)}
              aria-label="Revoke API key"
              disabled={isBusy}
            >
              <TrashIcon size={16} />
            </Button>
          </div>
          <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <WarningIcon size={14} className="mt-px shrink-0" />
            <p>
              Anyone with this key can invoke Sketch through the external API. Regenerate it if access is shared
              accidentally.
            </p>
          </div>
        </div>
      )}

      <AlertDialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The current key will stop working immediately. Systems using it must be updated with the new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={generateMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                generateMutation.mutate();
                setConfirmRegenerate(false);
              }}
              disabled={generateMutation.isPending}
            >
              {generateMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Regenerating...
                </>
              ) : (
                "Regenerate"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
            <AlertDialogDescription>
              API clients using this key will lose access immediately. You can generate a new key later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => revokeMutation.mutate()}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Revoking...
                </>
              ) : (
                "Revoke"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ApiTokensSection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("Claude Code");
  const [createdToken, setCreatedToken] = useState<{ plaintext: string; mcpUrl: string | null } | null>(null);
  const [setupToken, setSetupToken] = useState<{ plaintext?: string; mcpUrl: string | null } | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const tokensQuery = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.apiTokens.list(),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { name: string }) => api.apiTokens.create(payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
      setCreatedToken({ plaintext: result.plaintext, mcpUrl: result.mcpUrl });
      setSetupToken({ plaintext: result.plaintext, mcpUrl: result.mcpUrl });
      toast.success("Token created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.apiTokens.revoke(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
      setConfirmRevokeId(null);
      toast.success("Token revoked");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const trimmedName = name.trim();
  const tokens = tokensQuery.data?.tokens ?? [];
  const activeTokens = tokens.filter((token) => !token.revokedAt);
  const mcpUrl =
    tokensQuery.data?.mcpUrl ??
    (typeof window === "undefined" ? "https://<sketch-host>/mcp" : `${window.location.origin}/mcp`);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">MCP access</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-4 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-sm font-medium">Sketch MCP URL</p>
          <div className="mt-2 flex items-center gap-2">
            <Input value={mcpUrl} readOnly className="h-9 font-mono text-xs" aria-label="Sketch MCP URL" />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => copyTextToClipboard(mcpUrl).then(() => toast.success("MCP URL copied"))}
              aria-label="Copy MCP URL"
            >
              <CopySimpleIcon size={16} />
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Use this URL in Claude app connectors; use PATs below for clients that require a manual Bearer header.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9"
            maxLength={120}
            aria-label="Token name"
          />
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => createMutation.mutate({ name: trimmedName })}
            disabled={trimmedName.length === 0 || createMutation.isPending}
          >
            {createMutation.isPending ? <SpinnerGapIcon size={14} className="animate-spin" /> : <KeyIcon size={14} />}
            Create token
          </Button>
        </div>

        {createdToken ? (
          <div className="mt-4 rounded-md border border-brand-accent bg-brand-accent/[0.05] p-3">
            <p className="text-sm font-medium">New token</p>
            <div className="mt-2 flex items-center gap-2">
              <Input value={createdToken.plaintext} readOnly className="h-9 font-mono text-xs" aria-label="New token" />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => copyTextToClipboard(createdToken.plaintext).then(() => toast.success("Token copied"))}
                aria-label="Copy token"
              >
                <CopySimpleIcon size={16} />
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-md border border-border">
          {tokensQuery.isLoading ? (
            <Skeleton className="h-28 rounded-none" />
          ) : activeTokens.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">No active tokens</div>
          ) : (
            <div className="divide-y divide-border">
              {activeTokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{token.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {token.prefix}... · Created {formatDate(token.createdAt)}
                      {token.lastUsedAt ? ` · Last used ${formatDate(token.lastUsedAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSetupToken({ mcpUrl })}>
                      Setup
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="hover:text-destructive"
                      onClick={() => setConfirmRevokeId(token.id)}
                      aria-label={`Revoke ${token.name}`}
                    >
                      <TrashIcon size={16} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={setupToken !== null} onOpenChange={(open) => !open && setSetupToken(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Claude Code setup</AlertDialogTitle>
            <AlertDialogDescription>
              Use this server entry for clients that support custom Authorization headers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(
              {
                mcpServers: {
                  sketch: {
                    type: "http",
                    url: setupToken?.mcpUrl ?? mcpUrl,
                    headers: { Authorization: `Bearer ${setupToken?.plaintext ?? "skp_..."}` },
                  },
                },
              },
              null,
              2,
            )}
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                copyTextToClipboard(
                  JSON.stringify(
                    {
                      mcpServers: {
                        sketch: {
                          type: "http",
                          url: setupToken?.mcpUrl ?? mcpUrl,
                          headers: { Authorization: `Bearer ${setupToken?.plaintext ?? "skp_..."}` },
                        },
                      },
                    },
                    null,
                    2,
                  ),
                ).then(() => toast.success("Setup copied"))
              }
            >
              <CopySimpleIcon size={14} />
              Copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRevokeId !== null} onOpenChange={(open) => !open && setConfirmRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API token?</AlertDialogTitle>
            <AlertDialogDescription>This token will stop working immediately.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirmRevokeId && revokeMutation.mutate(confirmRevokeId)}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Revoking...
                </>
              ) : (
                "Revoke"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {}

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("Copy command failed");
  } finally {
    document.body.removeChild(textarea);
  }
}
