import type { User } from "@/lib/api";
import type { AuthContext } from "@/routes/dashboard";
import {
  DotsThreeIcon,
  EnvelopeIcon,
  LinkIcon,
  PencilSimpleIcon,
  RobotIcon,
  SlackLogoIcon,
  UserMinusIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react";
/**
 * MemberList — renders the team member list with per-row channel badges
 * and a dropdown for edit/remove/link-accounts actions.
 */
import { Avatar, AvatarFallback } from "@sketch/ui/components/avatar";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sketch/ui/components/tooltip";
import { getInitials } from "@sketch/ui/lib/utils";

export function MemberList({
  users,
  auth,
  onEdit,
  onRemove,
  onLink,
}: {
  users: User[];
  auth: AuthContext;
  onEdit: (user: User) => void;
  onRemove: (user: User) => void;
  onLink: (user: User) => void;
}) {
  const isMember = auth.role === "member";

  return (
    <>
      <p className="mb-3 text-sm font-medium text-muted-foreground">Team members</p>
      <div className="rounded-lg border border-border bg-card">
        {users.map((user, i) => {
          const isCurrentUser = isMember && user.id === auth.userId;

          return (
            <MemberRow
              key={user.id}
              user={user}
              isCurrentUser={isCurrentUser}
              isMember={isMember}
              isLast={i === users.length - 1}
              onEdit={() => onEdit(user)}
              onRemove={() => onRemove(user)}
              onLink={() => onLink(user)}
            />
          );
        })}
      </div>
    </>
  );
}

function MemberRow({
  user,
  isCurrentUser,
  isMember,
  isLast,
  onEdit,
  onRemove,
  onLink,
}: {
  user: User;
  isCurrentUser: boolean;
  isMember: boolean;
  isLast: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onLink: () => void;
}) {
  const initials = getInitials(user.name);
  const isAgent = user.type === "agent";
  const showActions = isMember ? isCurrentUser : !isCurrentUser;
  const showDelete = !isMember;

  return (
    <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
      <Avatar className="size-9">
        {isAgent ? (
          <AvatarFallback className="bg-primary/10 text-primary">
            <RobotIcon size={16} weight="fill" />
          </AvatarFallback>
        ) : (
          <AvatarFallback className="text-xs font-medium">{initials}</AvatarFallback>
        )}
      </Avatar>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{user.name}</span>
          {isCurrentUser && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              You
            </Badge>
          )}
          {isAgent && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              Agent
            </Badge>
          )}
        </div>
        {user.role && <span className="text-xs text-muted-foreground">{user.role}</span>}
        {user.description && <span className="truncate text-xs text-muted-foreground">{user.description}</span>}
      </div>

      {!isAgent && (
        <TooltipProvider>
          <div className="flex items-center gap-2">
            <ChannelBadge
              icon={<SlackLogoIcon size={16} />}
              active={!!user.slack_user_id}
              tooltip={user.slack_user_id ? "Slack connected" : "Slack not connected"}
              activeColor="#E01E5A"
            />
            <ChannelBadge
              icon={<WhatsappLogoIcon size={16} />}
              active={!!user.whatsapp_number}
              tooltip={user.whatsapp_number ? "WhatsApp connected" : "WhatsApp not connected"}
              activeColor="#25D366"
            />
            <ChannelBadge
              icon={<EnvelopeIcon size={16} />}
              active={!!user.email}
              tooltip={
                user.email
                  ? user.email_verified_at
                    ? "Email verified"
                    : "Email pending verification"
                  : "Email not added"
              }
              activeColor={user.email ? (user.email_verified_at ? "#0072FC" : "#F59E0B") : "#0072FC"}
            />
          </div>
        </TooltipProvider>
      )}

      {showActions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <DotsThreeIcon size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onLink}>
              <LinkIcon size={14} className="mr-2" />
              Link accounts
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}>
              <PencilSimpleIcon size={14} className="mr-2" />
              Edit
            </DropdownMenuItem>
            {showDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={onRemove}>
                  <UserMinusIcon size={14} className="mr-2" />
                  Remove member
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function ChannelBadge({
  icon,
  active,
  tooltip,
  activeColor,
}: {
  icon: React.ReactNode;
  active: boolean;
  tooltip: string;
  activeColor: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={active ? "" : "text-muted-foreground/50"} style={active ? { color: activeColor } : undefined}>
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}
