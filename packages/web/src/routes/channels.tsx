import { WhatsAppQR } from "@/components/whatsapp-qr";
import type { ChannelStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { generateSlackManifest } from "@/lib/slack-manifest";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopySimpleIcon,
  DotsThreeIcon,
  EnvelopeIcon,
  EnvelopeSimpleIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  WarningIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react";
/**
 * Channels page — displays Slack, WhatsApp, and Email platform cards with connection status.
 * WhatsApp pairing uses SSE-based QR flow via the shared WhatsAppQR component.
 * Email uses SMTP configuration for magic link delivery.
 */
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

export const channelsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/channels",
  component: ChannelsPage,
});

export function ChannelsPage() {
  const auth = useDashboardAuth();
  const readOnly = auth.role === "member";
  const { data, isLoading } = useQuery({
    queryKey: ["channels", "status"],
    queryFn: () => api.channels.status(),
    refetchInterval: 60000,
  });

  const allDisconnected = data?.channels?.every((ch) => ch.connected !== true);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-xl font-bold">Channels</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage your messaging platform connections</p>

      <div className="mt-6 space-y-4">
        {!isLoading && allDisconnected && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/5 p-4">
            <WarningIcon size={16} className="mt-0.5 shrink-0 text-warning" />
            <p className="text-sm text-warning">
              No channels connected — connect at least one channel so your team can message the bot.
            </p>
          </div>
        )}
        {isLoading ? (
          <>
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
          </>
        ) : (
          data?.channels.map((channel) => <PlatformCard key={channel.platform} channel={channel} readOnly={readOnly} />)
        )}
      </div>
    </div>
  );
}

function PlatformCard({ channel, readOnly }: { channel: ChannelStatus; readOnly: boolean }) {
  if (channel.platform === "slack") {
    return <SlackCard channel={channel} readOnly={readOnly} />;
  }
  if (channel.platform === "email") {
    return <EmailCard channel={channel} readOnly={readOnly} />;
  }
  return <WhatsAppCard channel={channel} readOnly={readOnly} />;
}

function SlackCard({ channel, readOnly }: { channel: ChannelStatus; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const isConfigured = channel.configured;
  const isConnected = channel.connected === true;

  const handleConnected = () => {
    setShowConnectDialog(false);
    toast.success("Slack connected.");
    queryClient.invalidateQueries({ queryKey: ["channels", "status"] });
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await api.channels.disconnectSlack();
      toast.success("Slack disconnected.");
      queryClient.invalidateQueries({ queryKey: ["channels", "status"] });
    } catch {
      toast.error("Failed to disconnect Slack.");
    } finally {
      setIsDisconnecting(false);
      setShowDisconnectDialog(false);
    }
  };

  return (
    <>
      <div
        className={`rounded-lg border p-4 ${isConfigured ? "border-border bg-card" : "border-dashed border-border bg-card"}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-muted">
              <SlackLogoIcon size={20} />
            </div>
            <span className="text-sm font-medium">Slack</span>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-2">
              {!isConfigured && (
                <Button variant="outline" size="sm" onClick={() => setShowConnectDialog(true)}>
                  Connect
                </Button>
              )}
              {isConfigured && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7">
                      <DotsThreeIcon size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem className="text-destructive" onClick={() => setShowDisconnectDialog(true)}>
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        <div className="ml-12 mt-2">
          {isConnected ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckIcon size={14} className="text-success" />
              <span>Connected</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Not connected</p>
              <p className="mt-1 text-xs text-muted-foreground">Connect a Slack workspace to get started</p>
            </>
          )}
        </div>
      </div>

      <SlackConnectDialog open={showConnectDialog} onOpenChange={setShowConnectDialog} onConnected={handleConnected} />

      <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Slack?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect Slack and remove the stored tokens. Users will no longer be able to message the bot
              via Slack.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDisconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDisconnect} disabled={isDisconnecting}>
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function WhatsAppCard({ channel, readOnly }: { channel: ChannelStatus; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [showPairDialog, setShowPairDialog] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const isConnected = channel.connected === true;

  const handlePairConnected = () => {
    setShowPairDialog(false);
    toast.success("WhatsApp connected.");
    queryClient.invalidateQueries({ queryKey: ["channels", "status"] });
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await api.whatsapp.disconnect();
      toast.success("WhatsApp disconnected.");
      queryClient.invalidateQueries({ queryKey: ["channels", "status"] });
    } catch {
      toast.error("Failed to disconnect WhatsApp.");
    } finally {
      setIsDisconnecting(false);
      setShowDisconnectDialog(false);
    }
  };

  return (
    <>
      <div
        className={`rounded-lg border p-4 ${isConnected ? "border-border bg-card" : "border-dashed border-border bg-card"}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-muted">
              <WhatsappLogoIcon size={20} />
            </div>
            <span className="text-sm font-medium">WhatsApp</span>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-2">
              {!isConnected && (
                <Button variant="outline" size="sm" onClick={() => setShowPairDialog(true)}>
                  Pair
                </Button>
              )}
              {isConnected && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7">
                      <DotsThreeIcon size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem className="text-destructive" onClick={() => setShowDisconnectDialog(true)}>
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        <div className="ml-12 mt-2">
          {isConnected ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckIcon size={14} className="text-success" />
              <span>Connected{channel.phoneNumber ? ` — ${channel.phoneNumber}` : ""}</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Not connected</p>
              <p className="mt-1 text-xs text-muted-foreground">Pair a WhatsApp number to get started</p>
            </>
          )}
        </div>
      </div>

      <WhatsAppPairDialog open={showPairDialog} onOpenChange={setShowPairDialog} onConnected={handlePairConnected} />

      <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect WhatsApp?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect your WhatsApp number. Users will no longer be able to message the bot via WhatsApp.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDisconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDisconnect} disabled={isDisconnecting}>
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function WhatsAppPairDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect WhatsApp</DialogTitle>
          <DialogDescription>Scan this QR code with WhatsApp to connect your number.</DialogDescription>
        </DialogHeader>
        {open && <WhatsAppQR onConnected={onConnected} />}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled>
            <SpinnerGapIcon className="size-3.5 animate-spin" />
            Waiting for scan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmailCard({ channel, readOnly }: { channel: ChannelStatus; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const isConfigured = channel.configured;

  const handleConfigured = () => {
    setShowConfigDialog(false);
    toast.success("Email SMTP configured.");
    queryClient.invalidateQueries({ queryKey: ["channels", "status"] });
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await api.channels.deleteEmail();
      toast.success("Email SMTP disconnected.");
      queryClient.invalidateQueries({ queryKey: ["channels", "status"] });
    } catch {
      toast.error("Failed to disconnect email.");
    } finally {
      setIsDisconnecting(false);
      setShowDisconnectDialog(false);
    }
  };

  return (
    <>
      <div
        className={`rounded-lg border p-4 ${isConfigured ? "border-border bg-card" : "border-dashed border-border bg-card"}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-muted">
              <EnvelopeIcon size={20} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Email</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Outbound only
              </span>
            </div>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-2">
              {!isConfigured && (
                <Button variant="outline" size="sm" onClick={() => setShowConfigDialog(true)}>
                  Configure
                </Button>
              )}
              {isConfigured && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7">
                      <DotsThreeIcon size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setShowConfigDialog(true)}>Reconfigure</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onClick={() => setShowDisconnectDialog(true)}>
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        <div className="ml-12 mt-2">
          {isConfigured ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckIcon size={14} className="text-success" />
              <span>SMTP configured</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Not configured</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Configure SMTP to send verification emails to your team
              </p>
            </>
          )}
        </div>
      </div>

      <EmailConfigDialog open={showConfigDialog} onOpenChange={setShowConfigDialog} onConfigured={handleConfigured} />

      <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Email?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the SMTP configuration. Verification emails will no longer be sent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDisconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDisconnect} disabled={isDisconnecting}>
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function EmailConfigDialog({
  open,
  onOpenChange,
  onConfigured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: () => void;
}) {
  const [host, setHost] = useState("smtp.gmail.com");
  const [port, setPort] = useState("465");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");

  const testMutation = useMutation({
    mutationFn: () =>
      api.channels.testEmail({ host: host.trim(), port: Number(port), user: user.trim(), password, from: from.trim() }),
    onSuccess: () => toast.success("SMTP connection successful!"),
    onError: (err: Error) => toast.error(err.message),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      api.channels.saveEmail({ host: host.trim(), port: Number(port), user: user.trim(), password, from: from.trim() }),
    onSuccess: () => {
      resetFields();
      onConfigured();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetFields = () => {
    setHost("smtp.gmail.com");
    setPort("465");
    setUser("");
    setPassword("");
    setFrom("");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) resetFields();
    onOpenChange(next);
  };

  const isValid = host.trim() && port && user.trim() && password && from.trim();
  const isPending = testMutation.isPending || saveMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure Email SMTP</DialogTitle>
          <DialogDescription>Enter your SMTP server details to send verification emails.</DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="mb-2 text-xs font-medium">Gmail App Password setup</p>
          <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
            <li>Go to Google Account &rarr; Security</li>
            <li>Enable 2-Step Verification if not already on</li>
            <li>Go to App Passwords (search &ldquo;App Passwords&rdquo; in account settings)</li>
            <li>Enter a name (e.g. &ldquo;Sketch&rdquo;) and click Create</li>
            <li>Copy the 16-character password &mdash; Google won&rsquo;t show it again</li>
            <li>Paste it in the Password field below</li>
          </ol>
          <div className="mt-2.5 flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener noreferrer">
                Enable 2-Step Verification
                <ArrowSquareOutIcon className="size-3.5" />
              </a>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href="https://myaccount.google.com/u/1/apppasswords" target="_blank" rel="noopener noreferrer">
                App Passwords
                <ArrowSquareOutIcon className="size-3.5" />
              </a>
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="smtp-host" className="text-xs">
              SMTP Host
            </Label>
            <Input
              id="smtp-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.gmail.com"
              disabled={isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-port" className="text-xs">
              Port
            </Label>
            <Input
              id="smtp-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="587"
              disabled={isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-user" className="text-xs">
              Username
            </Label>
            <Input
              id="smtp-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="you@gmail.com"
              disabled={isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-password" className="text-xs">
              Password
            </Label>
            <Input
              id="smtp-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="App password"
              disabled={isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from" className="text-xs">
              From address
            </Label>
            <Input
              id="smtp-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="noreply@yourcompany.com"
              disabled={isPending}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => testMutation.mutate()} disabled={!isValid || isPending}>
              {testMutation.isPending ? (
                <>
                  <SpinnerGapIcon className="size-3.5 animate-spin" />
                  Testing...
                </>
              ) : (
                "Test Connection"
              )}
            </Button>
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!isValid || isPending}>
              {saveMutation.isPending ? (
                <>
                  <SpinnerGapIcon className="size-3.5 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SlackConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [manifestCopied, setManifestCopied] = useState(false);

  const connectMutation = useMutation({
    mutationFn: async () => {
      await api.setup.verifySlack(botToken.trim(), appToken.trim());
      await api.setup.slack(botToken.trim(), appToken.trim());
    },
    onSuccess: () => {
      setBotToken("");
      setAppToken("");
      onConnected();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const handleCopyManifest = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generateSlackManifest());
      setManifestCopied(true);
      toast.success("Slack manifest copied to clipboard.");
      setTimeout(() => setManifestCopied(false), 2000);
    } catch {
      toast.error("Unable to copy manifest. Please try again.");
    }
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setBotToken("");
      setAppToken("");
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Slack</DialogTitle>
          <DialogDescription>Create a Slack app and paste the tokens to connect.</DialogDescription>
        </DialogHeader>

        <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
          <li>Copy the manifest below</li>
          <li>Go to api.slack.com/apps &rarr; &ldquo;Create New App&rdquo; &rarr; &ldquo;From a Manifest&rdquo;</li>
          <li>Select your workspace and paste the manifest</li>
          <li>Click &ldquo;Install to Workspace&rdquo;</li>
          <li>Copy the Bot Token (OAuth &amp; Permissions page) and App-Level Token</li>
          <li>Paste both tokens below</li>
        </ol>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCopyManifest}>
            {manifestCopied ? (
              <>
                <CheckIcon className="size-3.5 text-success" weight="bold" />
                Copied
              </>
            ) : (
              <>
                <CopySimpleIcon className="size-3.5" />
                Copy Manifest
              </>
            )}
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
              Open Slack API
              <ArrowSquareOutIcon className="size-3.5" />
            </a>
          </Button>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="slack-bot-token" className="text-xs">
              Bot Token
            </Label>
            <Input
              id="slack-bot-token"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="xoxb-..."
              disabled={connectMutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="slack-app-token" className="text-xs">
              App-Level Token
            </Label>
            <Input
              id="slack-app-token"
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
              placeholder="xapp-..."
              disabled={connectMutation.isPending}
              className="font-mono text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => connectMutation.mutate()}
            disabled={!botToken.trim() || !appToken.trim() || connectMutation.isPending}
          >
            {connectMutation.isPending ? (
              <>
                <SpinnerGapIcon className="size-3.5 animate-spin" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
