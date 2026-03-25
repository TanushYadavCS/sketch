import { ConnectionTestSection, useConnectionTest } from "@/components/connections/connection-test";
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

export function EditProviderDialog({
  server,
  onOpenChange,
  onSuccess,
}: {
  server: McpServerRecord | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"mcp" | "skill">("mcp");
  const test = useConnectionTest();

  const [lastServerId, setLastServerId] = useState<string | null>(null);
  if (server && server.id !== lastServerId) {
    setName(server.displayName);
    setMcpUrl(server.url);
    setApiUrl(server.apiUrl ?? "");
    setApiKey("");
    setMode((server.mode as "mcp" | "skill") ?? "mcp");
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
      if (mcpUrl.trim() !== server?.url) data.url = mcpUrl.trim();
      if (apiUrl.trim() !== (server?.apiUrl ?? "")) data.apiUrl = apiUrl.trim() || null;
      if (apiKey.trim()) data.credentials = { apiKey: apiKey.trim() };
      if (mode !== (server?.mode ?? "mcp")) data.mode = mode;
      return api.mcpServers.update(server?.id ?? "", data);
    },
    onSuccess: () => {
      toast.success("Provider updated");
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleTestConnection = () => {
    if (!mcpUrl.trim() || !server) return;
    if (apiKey.trim()) {
      test.runTest(mcpUrl.trim(), JSON.stringify({ apiKey: apiKey.trim() }));
    } else {
      test.runTest(server.id);
    }
  };

  const isDirty =
    server &&
    (name.trim() !== server.displayName ||
      mcpUrl.trim() !== server.url ||
      apiUrl.trim() !== (server.apiUrl ?? "") ||
      apiKey.trim() !== "" ||
      mode !== (server.mode ?? "mcp"));

  return (
    <Dialog open={!!server} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-sm font-bold text-muted-foreground">
              C
            </div>
            Edit Canvas
          </DialogTitle>
          <DialogDescription>Update the Canvas provider settings.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-provider-name">Name</Label>
            <Input
              id="edit-provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={updateMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-provider-mcp-url">MCP URL</Label>
            <Input
              id="edit-provider-mcp-url"
              value={mcpUrl}
              onChange={(e) => {
                setMcpUrl(e.target.value);
                if (test.testState !== "idle") test.resetToIdle();
              }}
              disabled={updateMutation.isPending}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-provider-api-url">API URL</Label>
            <Input
              id="edit-provider-api-url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              disabled={updateMutation.isPending}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-provider-api-key">API Key</Label>
            <Input
              id="edit-provider-api-key"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (test.testState !== "idle") test.resetToIdle();
              }}
              placeholder="Leave empty to keep current"
              disabled={updateMutation.isPending}
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
                disabled={updateMutation.isPending}
              >
                Skill
              </button>
              <button
                type="button"
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-r-lg transition-colors ${
                  mode === "mcp" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setMode("mcp")}
                disabled={updateMutation.isPending}
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
            disabled={!mcpUrl.trim() || updateMutation.isPending}
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
            disabled={!isDirty || !name.trim() || !mcpUrl.trim() || updateMutation.isPending}
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
