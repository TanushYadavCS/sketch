import type { SlackChannelInfo, User } from "@/lib/api";
import { api } from "@/lib/api";
import { HashIcon, LockIcon, SlackLogoIcon } from "@phosphor-icons/react";
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
 * SlackChannelsField — multiselect of Slack channels the bot has joined,
 * each labelled with the agent it is currently bound to (if any). Toggling
 * a channel that is already owned by another agent prompts a confirmation
 * before reassigning ownership to the current agent.
 */
export function SlackChannelsField({
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
  const { data, isLoading, isError } = useQuery({
    queryKey: ["slack-channels"],
    queryFn: () => api.channels.listSlack(),
  });

  const [pendingReassign, setPendingReassign] = useState<{
    channel: SlackChannelInfo;
    previousOwner: string;
  } | null>(null);

  const selected = new Set(value);

  const ownerByChannelId = new Map<string, { id: string; name: string }>();
  for (const u of users) {
    if (u.type !== "agent" || !u.slack_channel_ids) continue;
    if (selfId && u.id === selfId) continue;
    for (const channelId of u.slack_channel_ids) {
      ownerByChannelId.set(channelId, { id: u.id, name: u.name });
    }
  }

  const toggle = (channel: SlackChannelInfo) => {
    if (selected.has(channel.id)) {
      onChange(value.filter((id) => id !== channel.id));
      return;
    }
    const owner = ownerByChannelId.get(channel.id);
    if (owner) {
      setPendingReassign({ channel, previousOwner: owner.name });
      return;
    }
    onChange([...value, channel.id]);
  };

  const confirmReassign = () => {
    if (pendingReassign) {
      onChange([...value, pendingReassign.channel.id]);
      setPendingReassign(null);
    }
  };

  return (
    <div className="space-y-2">
      <Label>Owns Slack channels</Label>
      <p className="text-xs text-muted-foreground">
        When this agent is bound to a channel, every @mention in that channel runs as this agent with the instructions
        and tools defined here.
      </p>
      <div className="rounded-md border border-border p-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        ) : isError ? (
          <p className="text-xs text-muted-foreground">
            Slack is not connected. Connect Slack to assign channels to this agent.
          </p>
        ) : (data?.channels ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            The Sketch bot is not in any channels yet. Invite it to a channel and reload.
          </p>
        ) : (
          <div className="space-y-1">
            {(data?.channels ?? []).map((channel) => {
              const owner = ownerByChannelId.get(channel.id);
              const id = `slack-channel-${channel.id}`;
              return (
                <label
                  key={channel.id}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={selected.has(channel.id)}
                    onChange={() => toggle(channel)}
                    disabled={disabled}
                    className="size-4 rounded border-border"
                  />
                  <ChannelIcon type={channel.type} />
                  <span className="text-sm font-medium">{channel.name}</span>
                  {owner && !selected.has(channel.id) && (
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
            <AlertDialogTitle>Reassign #{pendingReassign?.channel.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This channel is currently owned by {pendingReassign?.previousOwner}. Saving will move ownership to{" "}
              {selfName}, and {pendingReassign?.previousOwner} will stop responding to @mentions in this channel.
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

function ChannelIcon({ type }: { type: string }) {
  if (type === "private_channel") {
    return <LockIcon size={14} className="text-muted-foreground" />;
  }
  if (type === "im" || type === "mpim") {
    return <SlackLogoIcon size={14} className="text-muted-foreground" />;
  }
  return <HashIcon size={14} className="text-muted-foreground" />;
}
