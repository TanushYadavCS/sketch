import type { User } from "@/lib/api";
import { Label } from "@sketch/ui/components/label";
import { Switch } from "@sketch/ui/components/switch";

/**
 * WhatsappFallbackField — toggle that designates this agent as the WhatsApp
 * fallback. It is a radio-across-agents at the API layer, so we surface the
 * current owner inline as a hint when toggling on for a different agent.
 */
export function WhatsappFallbackField({
  value,
  onChange,
  users,
  selfId,
  disabled,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  users: User[];
  selfId?: string | null;
  disabled?: boolean;
}) {
  const currentOwner = users.find((u) => u.is_whatsapp_fallback && u.id !== selfId);

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="agent-whatsapp-fallback" className="font-medium">
          Set as WhatsApp fallback
        </Label>
        <Switch id="agent-whatsapp-fallback" checked={value} onCheckedChange={onChange} disabled={disabled} />
      </div>
      <p className="text-xs text-muted-foreground">
        WhatsApp DMs from numbers not linked to a teammate are routed to the fallback agent. Only one agent can be the
        fallback at a time.
      </p>
      {value && currentOwner && (
        <p className="text-xs text-amber-600">
          Saving will move the WhatsApp fallback role from {currentOwner.name} to this agent.
        </p>
      )}
    </div>
  );
}
