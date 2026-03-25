import { DotsThreeIcon, GearIcon, PencilSimpleIcon, PlugIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { McpServerRecord } from "@sketch/shared";
/**
 * MCP Servers section: admin CRUD for workspace-level MCP servers.
 */
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";

export function McpServersSection({
  servers,
  onAdd,
  onEdit,
  onRemove,
  onTestConnection,
}: {
  servers: McpServerRecord[];
  onAdd: () => void;
  onEdit: (server: McpServerRecord) => void;
  onRemove: (server: McpServerRecord) => void;
  onTestConnection: (server: McpServerRecord) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">MCP Servers</p>
        <Button size="sm" className="gap-1.5" onClick={onAdd}>
          <PlusIcon size={14} weight="bold" />
          New server
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <GearIcon size={24} className="text-muted-foreground" />
          </div>
          <p className="mt-4 text-sm font-medium">No MCP servers configured</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Connect a custom MCP server to give the agent access to your internal tools.
          </p>
          <Button size="sm" className="mt-4 gap-1.5" onClick={onAdd}>
            <PlusIcon size={14} weight="bold" />
            New server
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          {servers.map((server, i) => (
            <McpServerRow
              key={server.id}
              server={server}
              isLast={i === servers.length - 1}
              onEdit={() => onEdit(server)}
              onRemove={() => onRemove(server)}
              onTestConnection={() => onTestConnection(server)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function McpServerRow({
  server,
  isLast,
  onEdit,
  onRemove,
  onTestConnection,
}: {
  server: McpServerRecord;
  isLast: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onTestConnection: () => void;
}) {
  return (
    <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
      <div className="flex size-9 items-center justify-center rounded-full bg-muted">
        <GearIcon size={16} className="text-muted-foreground" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{server.displayName}</span>
          {server.type && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {server.type}
            </Badge>
          )}
        </div>
        <span className="truncate text-xs font-mono text-muted-foreground">{server.url}</span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7">
            <DotsThreeIcon size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <PencilSimpleIcon size={14} className="mr-2" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onTestConnection}>
            <PlugIcon size={14} className="mr-2" />
            Test connection
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onClick={onRemove}>
            <TrashIcon size={14} className="mr-2" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
