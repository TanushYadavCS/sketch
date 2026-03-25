import { ConnectionTestSection, useConnectionTest } from "@/components/connections/connection-test";
import { CaretIcon } from "@/components/connections/shared";
import { api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
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

export function AddMcpDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credentials, setCredentials] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const test = useConnectionTest();

  const addMutation = useMutation({
    mutationFn: () => {
      const creds: Record<string, unknown> = {};
      if (credentials.trim()) creds.apiKey = credentials.trim();
      return api.mcpServers.add({ displayName: name.trim(), url: url.trim(), credentials: creds });
    },
    onSuccess: (server) => {
      toast.success(`${server.displayName} added`);
      resetAndClose();
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetAndClose = () => {
    setName("");
    setUrl("");
    setCredentials("");
    setShowAuth(false);
    test.reset();
    onOpenChange(false);
  };

  const handleTestConnection = () => {
    if (!url.trim()) return;
    const creds: Record<string, string> = {};
    if (credentials.trim()) creds.apiKey = credentials.trim();
    test.runTest(url.trim(), JSON.stringify(creds));
  };

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
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>Connect an MCP server to give the agent access to its tools.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">Server name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GitHub, Sentry, Internal Tools"
              disabled={addMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-url">MCP URL</Label>
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (test.testState !== "idle") test.resetToIdle();
              }}
              placeholder="https://mcp.example.com/sse"
              disabled={addMutation.isPending}
              className="font-mono text-xs"
            />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAuth(!showAuth)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <CaretIcon direction={showAuth ? "up" : "down"} />
              Authentication
            </button>

            {showAuth && (
              <div className="mt-3 space-y-1.5">
                <Label htmlFor="mcp-credentials">API key / Bearer token</Label>
                <Input
                  id="mcp-credentials"
                  type="password"
                  value={credentials}
                  onChange={(e) => setCredentials(e.target.value)}
                  disabled={addMutation.isPending}
                  className="font-mono text-xs"
                />
              </div>
            )}
          </div>

          <ConnectionTestSection
            testState={test.testState}
            testResult={test.testResult}
            onTest={handleTestConnection}
            disabled={!url.trim() || addMutation.isPending}
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={addMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => addMutation.mutate()} disabled={!name.trim() || !url.trim() || addMutation.isPending}>
            {addMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Adding...
              </>
            ) : (
              "Add server"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
