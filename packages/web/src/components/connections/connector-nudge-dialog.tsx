import { ConnectIntegrationDialog } from "@/components/connect-integration-dialog";
import { type IntegrationDefinition, type IntegrationType, getIntegration } from "@/lib/integrations";
import { FolderOpenIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { useEffect, useMemo, useState } from "react";
import { AppIcon } from "./app-icon";

export interface ConnectorNudgeSuggestion {
  connectorType: string;
  appId: string;
  accountId?: string;
  appName?: string;
  icon?: string;
}

export function ConnectorNudgeDialog({
  suggestion,
  onOpenChange,
  onConnected,
}: {
  suggestion: ConnectorNudgeSuggestion | null;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const definition = useMemo(
    () => (suggestion ? getIntegration(suggestion.connectorType as IntegrationType) : undefined),
    [suggestion],
  );
  const suggestionKey = suggestion
    ? `${suggestion.connectorType}:${suggestion.appId}:${suggestion.accountId ?? ""}`
    : null;

  useEffect(() => {
    if (!suggestionKey) return;
    setConnecting(false);
  }, [suggestionKey]);

  const close = () => {
    setConnecting(false);
    onOpenChange(false);
  };

  if (!suggestion || !definition) return null;

  return (
    <>
      <Dialog open={!connecting} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3 pr-8">
              <AppIcon
                name={suggestion.appName ?? definition.name}
                icon={suggestion.icon}
                className="size-9 rounded-lg text-xs"
                imageClassName="size-7"
              />
              <div className="min-w-0">
                <DialogTitle>Add {definition.name} to the org brain?</DialogTitle>
                <DialogDescription className="mt-1">
                  Index the {suggestion.appName ?? definition.name} account you just connected so Sketch can search{" "}
                  {connectorItemCopy(definition)} in Files and use it in chat.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
              <FolderOpenIcon size={16} className="text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">Searchable in Files</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sketch will index your personal account. You can choose the sync scope when there is one.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Not now
            </Button>
            <Button onClick={() => setConnecting(true)}>Add to org brain</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConnectIntegrationDialog
        integration={definition}
        open={connecting}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        onConnected={() => {
          onConnected();
          close();
        }}
        preferCanvasCredentialSource={true}
        canvasConnectionReady={true}
        canvasAccountId={suggestion.accountId}
      />
    </>
  );
}

function connectorItemCopy(definition: IntegrationDefinition): string {
  if (definition.type === "gmail" || definition.type === "outlook") return "your mailbox";
  if (definition.type === "teams") return "your meetings";
  if (definition.type === "google_calendar") return "your calendars";
  if (definition.type === "google_drive") return "your selected files";
  return `your ${definition.itemNoun}`;
}
