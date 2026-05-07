import type { User, WhatsAppGroupInfo } from "@/lib/api";
import { api } from "@/lib/api";
import { UsersThreeIcon } from "@phosphor-icons/react";
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
import { Label } from "@sketch/ui/components/label";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

/**
 * WhatsAppGroupsField — multiselect of WhatsApp groups the bot has seen,
 * each labelled with the agent it is currently bound to (if any). Mirror
 * of SlackChannelsField for the WhatsApp surface.
 */
export function WhatsAppGroupsField({
  value,
  onChange,
  users,
  selfId,
  selfName,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  users: User[];
  selfId?: string | null;
  selfName: string;
  disabled?: boolean;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-groups"],
    queryFn: () => api.channels.listWhatsAppGroups(),
  });

  const [pendingReassign, setPendingReassign] = useState<{
    group: WhatsAppGroupInfo;
    previousOwner: string;
  } | null>(null);

  const selected = new Set(value);

  const ownerByJid = new Map<string, { id: string; name: string }>();
  for (const u of users) {
    if (u.type !== "agent" || !u.whatsapp_group_jids) continue;
    if (selfId && u.id === selfId) continue;
    for (const jid of u.whatsapp_group_jids) {
      ownerByJid.set(jid, { id: u.id, name: u.name });
    }
  }

  const toggle = (group: WhatsAppGroupInfo) => {
    if (selected.has(group.jid)) {
      onChange(value.filter((jid) => jid !== group.jid));
      return;
    }
    const owner = ownerByJid.get(group.jid);
    if (owner) {
      setPendingReassign({ group, previousOwner: owner.name });
      return;
    }
    onChange([...value, group.jid]);
  };

  const confirmReassign = () => {
    if (pendingReassign) {
      onChange([...value, pendingReassign.group.jid]);
      setPendingReassign(null);
    }
  };

  const groups = data?.groups ?? [];

  return (
    <div className="space-y-2">
      <Label>Owns WhatsApp groups</Label>
      <p className="text-xs text-muted-foreground">
        When this agent is bound to a group, every @mention in that group runs as this agent with the instructions and
        tools defined here.
      </p>
      <div className="rounded-md border border-border p-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        ) : groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            The Sketch bot is not in any WhatsApp groups yet. Add it to a group and reload.
          </p>
        ) : (
          <div className="space-y-1">
            {groups.map((group) => {
              const owner = ownerByJid.get(group.jid);
              const id = `whatsapp-group-${group.jid}`;
              return (
                <label
                  key={group.jid}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={selected.has(group.jid)}
                    onChange={() => toggle(group)}
                    disabled={disabled}
                    className="size-4 rounded border-border"
                  />
                  <UsersThreeIcon size={14} className="text-muted-foreground" />
                  <span className="text-sm font-medium">{group.name}</span>
                  {owner && !selected.has(group.jid) && (
                    <span className="ml-auto text-xs text-muted-foreground">currently owned by {owner.name}</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog open={!!pendingReassign} onOpenChange={(open) => !open && setPendingReassign(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reassign {pendingReassign?.group.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This group is currently owned by {pendingReassign?.previousOwner}. Saving will move ownership to{" "}
              {selfName}, and {pendingReassign?.previousOwner} will stop responding to @mentions in this group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReassign}>Reassign</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
