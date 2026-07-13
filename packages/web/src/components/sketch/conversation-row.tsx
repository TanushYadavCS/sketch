import {
  BrowserIcon,
  DotsThreeIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TrashIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";

export type ConversationChannel = "web" | "slack" | "whatsapp";

export interface ConversationRowProps {
  id: string;
  title: string;
  channel: ConversationChannel;
  occurredAt: string;
  now?: Date;
  onConversationIntent?: (conversationId: string) => void;
}

const CHANNEL_ICON = {
  web: BrowserIcon,
  slack: SlackLogoIcon,
  whatsapp: WhatsappLogoIcon,
} as const;

const CHANNEL_LABEL = {
  web: "Dashboard",
  slack: "Slack",
  whatsapp: "WhatsApp",
} as const;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatRelative(occurredAt: string, now: Date = new Date()): string {
  const then = new Date(occurredAt);
  const diffMs = now.getTime() - then.getTime();
  if (Number.isNaN(then.getTime()) || diffMs < 0) return "now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 28) return `${Math.floor(diffDays / 7)}w`;
  const sameYear = then.getFullYear() === now.getFullYear();
  return sameYear
    ? `${MONTH_NAMES[then.getMonth()]} ${then.getDate()}`
    : `${MONTH_NAMES[then.getMonth()]} ${then.getFullYear()}`;
}

interface ConversationRowActionProps {
  onDelete?: () => void;
  isDeleting?: boolean;
}

export function ConversationRow({
  id,
  title,
  channel,
  occurredAt,
  now,
  onDelete,
  isDeleting,
  onConversationIntent,
}: ConversationRowProps & ConversationRowActionProps) {
  const ChannelIcon = CHANNEL_ICON[channel];
  const content = (
    <>
      <span
        aria-label={CHANNEL_LABEL[channel]}
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted-foreground"
      >
        <ChannelIcon size={16} weight="regular" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatRelative(occurredAt, now)}</span>
    </>
  );

  if (!onDelete) {
    return (
      <Link
        to="/chat/$conversationId"
        params={{ conversationId: id }}
        viewTransition
        onMouseEnter={() => onConversationIntent?.(id)}
        onFocus={() => onConversationIntent?.(id)}
        className={cn(
          "group flex w-full items-center gap-[12px] rounded-[6px] px-[8px] py-[8px]",
          "transition-colors duration-100 ease-out hover:bg-accent",
        )}
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-[12px] rounded-[6px] px-[8px] py-[8px]",
        "transition-colors duration-100 ease-out hover:bg-accent",
      )}
    >
      <Link
        to="/chat/$conversationId"
        params={{ conversationId: id }}
        viewTransition
        onMouseEnter={() => onConversationIntent?.(id)}
        onFocus={() => onConversationIntent?.(id)}
        className="flex min-w-0 flex-1 items-center gap-[12px]"
      >
        {content}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Conversation actions for ${title}`}
            disabled={isDeleting}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
          >
            {isDeleting ? <SpinnerGapIcon size={14} className="animate-spin" /> : <DotsThreeIcon size={16} />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" disabled={isDeleting} onClick={onDelete}>
            <TrashIcon size={16} />
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
