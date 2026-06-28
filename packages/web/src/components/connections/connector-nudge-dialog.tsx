import { ConnectIntegrationDialog, IntegrationIcon } from "@/components/connect-integration-dialog";
import { type IntegrationDefinition, type IntegrationType, getIntegration } from "@/lib/integrations";
import { DatabaseIcon } from "@phosphor-icons/react";
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

export interface ConnectorNudgeSuggestion {
  connectorType: string;
  appId: string;
  accountId?: string;
  appName?: string;
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
  const suggestionKey = suggestion ? `${suggestion.connectorType}:${suggestion.appId}` : null;

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
              <IntegrationIcon color={definition.color} name={definition.name} type={definition.type} size="md" />
              <div className="min-w-0">
                <DialogTitle>Sync {definition.name} into Files?</DialogTitle>
                <DialogDescription className="mt-1">
                  Use the {suggestion.appName ?? definition.name} account you just connected to index{" "}
                  {connectorItemCopy(definition)} for search and chat.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
              <DatabaseIcon size={16} className="text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">Personal connector</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Only your account is connected. You can manage sync scope from Files.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Not now
            </Button>
            <Button onClick={() => setConnecting(true)}>Connect connector</Button>
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
