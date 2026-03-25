/**
 * Provider setup flow: ProviderSelectorDialog (step 1) -> AddProviderDialog (step 2).
 * Also includes ComingSoonDialog for unavailable providers.
 */
import { ConnectionTestSection, useConnectionTest } from "@/components/connections/connection-test";
import { api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
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
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

const PROVIDERS = [
  {
    id: "canvas" as const,
    name: "Canvas",
    available: true,
    description: "Per-user OAuth for 2,700+ services. Each team member connects their own accounts securely.",
  },
  {
    id: "composio" as const,
    name: "Composio",
    available: false,
    description: "AI-native integration toolkit with 250+ tools. Built for agentic workflows.",
  },
  {
    id: "nango" as const,
    name: "Nango",
    available: false,
    description: "Open-source unified API for 250+ integrations. Self-hostable.",
  },
];

export function ProviderSelectorDialog({
  open,
  onOpenChange,
  onSelectCanvas,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectCanvas: () => void;
}) {
  const [comingSoonProvider, setComingSoonProvider] = useState<string | null>(null);

  return (
    <>
      <Dialog open={open && !comingSoonProvider} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a provider</DialogTitle>
            <DialogDescription>
              Choose an integration provider to enable per-user app connections for your workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="flex w-full items-center gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:bg-muted/50 hover:border-muted-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-border"
                disabled={!p.available}
                onClick={() => {
                  if (p.available) {
                    onSelectCanvas();
                  } else {
                    setComingSoonProvider(p.name);
                  }
                }}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-bold text-muted-foreground">
                  {p.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{p.name}</span>
                    {p.available ? (
                      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 text-[10px] px-1.5 py-0 hover:bg-emerald-100 dark:hover:bg-emerald-900/40">
                        Available
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        Coming soon
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <ComingSoonDialog
        providerName={comingSoonProvider}
        onOpenChange={(next) => {
          if (!next) setComingSoonProvider(null);
        }}
        onBack={() => setComingSoonProvider(null)}
      />
    </>
  );
}

function ComingSoonDialog({
  providerName,
  onOpenChange,
  onBack,
}: {
  providerName: string | null;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
}) {
  const provider = PROVIDERS.find((p) => p.name === providerName);

  return (
    <Dialog open={!!providerName} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-sm font-bold text-muted-foreground">
              {providerName?.[0]}
            </div>
            {providerName}
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              Coming soon
            </Badge>
          </DialogTitle>
          <DialogDescription>{provider?.description}</DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <p className="text-sm text-foreground/80">
              {providerName} support is on our roadmap. We're working on deep integration with their API.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">Want to help? Contributions are welcome.</p>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Previous
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AddProviderDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("Canvas");
  const [mcpUrl, setMcpUrl] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"mcp" | "skill">("skill");
  const test = useConnectionTest();

  const addMutation = useMutation({
    mutationFn: () =>
      api.mcpServers.add({
        displayName: name.trim(),
        url: mcpUrl.trim(),
        apiUrl: apiUrl.trim(),
        credentials: { apiKey: apiKey.trim() },
        type: "canvas",
        mode,
      }),
    onSuccess: (server) => {
      toast.success(`${server.displayName} connected`);
      resetAndClose();
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetAndClose = () => {
    setName("Canvas");
    setMcpUrl("");
    setApiUrl("");
    setApiKey("");
    setMode("skill");
    test.reset();
    onOpenChange(false);
  };

  const handleTestConnection = () => {
    if (!mcpUrl.trim()) return;
    const creds = apiKey.trim() ? JSON.stringify({ apiKey: apiKey.trim() }) : "{}";
    test.runTest(mcpUrl.trim(), creds);
  };

  const canSubmit = name.trim() && mcpUrl.trim() && apiUrl.trim() && apiKey.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
        else onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-sm font-bold text-muted-foreground">
              C
            </div>
            Connect Canvas
          </DialogTitle>
          <DialogDescription>Canvas provides per-user OAuth for 2,700+ services.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
              How to get your API key
            </p>
            <ol className="space-y-2.5">
              <li className="flex items-start gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  1
                </span>
                <span className="text-sm text-foreground/80">
                  Go to{" "}
                  <a
                    href="https://app.canvasx.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    app.canvasx.ai
                  </a>
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  2
                </span>
                <span className="text-sm text-foreground/80">Create an account or sign in</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  3
                </span>
                <span className="text-sm text-foreground/80">Navigate to API Keys</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  4
                </span>
                <span className="text-sm text-foreground/80">Copy your API key</span>
              </li>
            </ol>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-name">Name</Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Canvas"
              disabled={addMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-mcp-url">MCP URL</Label>
            <Input
              id="provider-mcp-url"
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
              placeholder="https://app.canvasx.ai/mcp"
              disabled={addMutation.isPending}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-api-url">API URL</Label>
            <Input
              id="provider-api-url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://app.canvasx.ai"
              disabled={addMutation.isPending}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-api-key">API Key</Label>
            <Input
              id="provider-api-key"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (test.testState !== "idle") test.resetToIdle();
              }}
              placeholder="cvs_..."
              disabled={addMutation.isPending}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Tool Access Mode</Label>
            <div className="flex rounded-lg border border-border">
              <button
                type="button"
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-l-lg transition-colors ${
                  mode === "skill"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setMode("skill")}
                disabled={addMutation.isPending}
              >
                Skill
              </button>
              <button
                type="button"
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-r-lg transition-colors ${
                  mode === "mcp" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setMode("mcp")}
                disabled={addMutation.isPending}
              >
                MCP
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {mode === "skill"
                ? "Agent uses the Canvas skill with CLI. Recommended."
                : "Tools injected directly into agent runs."}
            </p>
          </div>

          <ConnectionTestSection
            testState={test.testState}
            testResult={test.testResult}
            onTest={handleTestConnection}
            disabled={!mcpUrl.trim() || addMutation.isPending}
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={addMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => addMutation.mutate()} disabled={!canSubmit || addMutation.isPending}>
            {addMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
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
