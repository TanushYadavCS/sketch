import { api } from "@/lib/api";
import { PlugIcon, PlusIcon, SpinnerGapIcon, TrashIcon } from "@phosphor-icons/react";
import type { IntegrationConnection } from "@sketch/shared";
/**
 * Integrations section: shows the user's connected apps via an integration provider.
 * All users can add and disconnect apps.
 */
import { Button } from "@sketch/ui/components/button";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { getAbbreviation } from "@sketch/ui/lib/utils";
import { useState } from "react";
import { toast } from "sonner";

export function IntegrationsSection({
  connections,
  isLoadingConnections,
  providerId,
  onAdd,
  onDisconnect,
}: {
  connections: IntegrationConnection[];
  isLoadingConnections: boolean;
  providerId: string;
  onAdd: () => void;
  onDisconnect: () => void;
}) {
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const handleDisconnect = async (connectionId: string) => {
    setDisconnectingId(connectionId);
    try {
      await api.mcpServers.removeConnection(providerId, connectionId);
      toast.success("Integration disconnected");
      onDisconnect();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <div>
      {isLoadingConnections ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4 border-b border-border last:border-b-0">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-brand-accent/[0.04] px-6 pt-8 pb-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-brand-accent bg-white">
            <PlugIcon size={24} className="text-[#8B7A00]" />
          </div>
          <p className="mt-3 text-sm font-medium">No apps connected yet</p>
          <p className="mt-1.5 text-sm text-muted-foreground">Add an integration to connect your apps.</p>
          <Button variant="ghost" size="sm" className="mt-4 gap-1.5 hover:bg-brand-accent/8" onClick={onAdd}>
            <PlusIcon size={14} weight="bold" />
            Add integration
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {connections.map((connection, i) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              isLast={i === connections.length - 1}
              isDisconnecting={disconnectingId === connection.id}
              onDisconnect={() => handleDisconnect(connection.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  isLast,
  isDisconnecting,
  onDisconnect,
}: {
  connection: IntegrationConnection;
  isLast: boolean;
  isDisconnecting: boolean;
  onDisconnect: () => void;
}) {
  const isActive = connection.status === "active";
  const abbrev = getAbbreviation(connection.appName);

  return (
    <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
      {connection.icon ? (
        <img src={connection.icon} alt={connection.appName} className="size-9 shrink-0 rounded-lg" />
      ) : (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
          style={{ backgroundColor: "#6B7280", borderRadius: 8 }}
        >
          {abbrev}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-semibold">{connection.appName}</span>
        <span className="text-xs text-muted-foreground">
          {connection.accountName && <span>{connection.accountName} · </span>}
          Connected {new Date(connection.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        {isActive ? (
          <>
            <span className="size-2 rounded-full bg-success" />
            <span className="text-xs text-muted-foreground">Active</span>
          </>
        ) : (
          <>
            <span className="size-2 rounded-full bg-destructive" />
            <span className="text-xs text-muted-foreground capitalize">{connection.status}</span>
          </>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-destructive"
        onClick={onDisconnect}
        disabled={isDisconnecting}
      >
        {isDisconnecting ? <SpinnerGapIcon size={14} className="animate-spin" /> : <TrashIcon size={14} />}
      </Button>
    </div>
  );
}
