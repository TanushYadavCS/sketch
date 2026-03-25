import { ConnectionTestSection, useConnectionTest } from "@/components/connections/connection-test";
import { CaretIcon } from "@/components/connections/shared";
import { api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import type { McpServerRecord } from "@sketch/shared";
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

export function EditMcpDialog({
  server,
  onOpenChange,
  onSuccess,
}: {
  server: McpServerRecord | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [credentials, setCredentials] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const test = useConnectionTest();

  const [lastServerId, setLastServerId] = useState<string | null>(null);
  if (server && server.id !== lastServerId) {
    setName(server.displayName);
    setUrl(server.url);
    setApiUrl(server.apiUrl ?? "");
    setCredentials("");
    setShowAuth(false);
    test.reset();
    setLastServerId(server.id);
  }
  if (!server && lastServerId) {
    setLastServerId(null);
  }

  const updateMutation = useMutation({
    mutationFn: () => {
      const data: Parameters<typeof api.mcpServers.update>[1] = {};
      if (name.trim() !== server?.displayName) data.displayName = name.trim();
      if (url.trim() !== server?.url) data.url = url.trim();
      if (server?.type && apiUrl.trim() !== (server?.apiUrl ?? "")) data.apiUrl = apiUrl.trim() || null;
      if (credentials.trim()) data.credentials = { apiKey: credentials.trim() };
      return api.mcpServers.update(server?.id ?? "", data);
    },
    onSuccess: () => {
      toast.success("MCP server updated");
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleTestConnection = () => {
    if (!url.trim()) return;
    const credsStr = credentials.trim()
      ? JSON.stringify({ apiKey: credentials.trim() })
      : (server?.credentials ?? "{}");
    test.runTest(url.trim(), credsStr);
  };

  const isDirty =
    server &&
    (name.trim() !== server.displayName ||
      url.trim() !== server.url ||
      apiUrl.trim() !== (server.apiUrl ?? "") ||
      credentials.trim() !== "");

  return (
    <Dialog open={!!server} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit MCP server</DialogTitle>
          <DialogDescription>Update the server connection settings.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-mcp-name">Server name</Label>
            <Input
              id="edit-mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={updateMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-mcp-url">MCP URL</Label>
            <Input
              id="edit-mcp-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (test.testState !== "idle") test.resetToIdle();
              }}
              disabled={updateMutation.isPending}
              className="font-mono text-xs"
            />
          </div>

          {server?.type && (
            <div className="space-y-1.5">
              <Label htmlFor="edit-mcp-api-url">API URL</Label>
              <Input
                id="edit-mcp-api-url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                disabled={updateMutation.isPending}
                className="font-mono text-xs"
              />
            </div>
          )}

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
                <Label htmlFor="edit-mcp-credentials">API key / Bearer token</Label>
                <Input
                  id="edit-mcp-credentials"
                  type="password"
                  value={credentials}
                  onChange={(e) => setCredentials(e.target.value)}
                  placeholder="Leave empty to keep current"
                  disabled={updateMutation.isPending}
                  className="font-mono text-xs"
                />
              </div>
            )}
          </div>

          <ConnectionTestSection
            testState={test.testState}
            testResult={test.testResult}
            onTest={handleTestConnection}
            disabled={!url.trim() || updateMutation.isPending}
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={updateMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={() => updateMutation.mutate()}
            disabled={!isDirty || !name.trim() || !url.trim() || updateMutation.isPending}
          >
            {updateMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Saving...
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
