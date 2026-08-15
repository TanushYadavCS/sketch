import { ConversationRow } from "@/components/sketch/conversation-row";
import { api } from "@/lib/api";
import { createWebChatConversationId, shouldUseChatViewTransition } from "@/lib/chat-target";
import { WEB_CHAT_CONVERSATIONS_QUERY_KEY, buildWebChatRecents } from "@/lib/web-chat-conversations";
import {
  ArrowSquareOutIcon,
  BrainIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  ChartBarIcon,
  DesktopIcon,
  FolderSimpleIcon,
  FoldersIcon,
  GearIcon,
  HashIcon,
  HouseIcon,
  type IconProps,
  LinkSimpleIcon,
  MoonIcon,
  NotePencilIcon,
  PlusIcon,
  RobotIcon,
  SignOutIcon,
  SunIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@sketch/ui/components/sidebar";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { cn, getInitials } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ComponentType, useEffect, useMemo, useState } from "react";

type InternalHref =
  | "/home"
  | "/agents"
  | "/projects"
  | "/scheduled-tasks"
  | "/channels"
  | "/integrations"
  | "/files"
  | "/team"
  | "/skills"
  | "/usage"
  | "/settings";

interface NavItem {
  label: string;
  href: InternalHref;
  icon: ComponentType<IconProps>;
  adminOnly?: boolean;
  yourOrgBadge?: boolean;
}

const PINNED_NAV: NavItem[] = [
  { label: "Home", href: "/home", icon: HouseIcon },
  { label: "Agents", href: "/agents", icon: RobotIcon },
  { label: "Your org", href: "/projects", icon: FoldersIcon, adminOnly: true, yourOrgBadge: true },
  { label: "Automations", href: "/scheduled-tasks", icon: CalendarDotsIcon },
];

const MORE_NAV: NavItem[] = [
  { label: "Channels", href: "/channels", icon: HashIcon },
  { label: "Integrations", href: "/integrations", icon: LinkSimpleIcon },
  { label: "Files", href: "/files", icon: FolderSimpleIcon },
  { label: "Access", href: "/team", icon: UsersThreeIcon },
  { label: "Skills", href: "/skills", icon: BrainIcon },
  { label: "Usage", href: "/usage", icon: ChartBarIcon },
  { label: "Settings", href: "/settings", icon: GearIcon },
];

/**
 * Neutral row styling that overrides the SidebarMenuButton primitive's default
 * active/hover states (which map to the olive `--sidebar-accent-foreground`
 * token). Matches the Variant-F prototype: muted by default, near-foreground
 * text on a faint gray wash when active or hovered.
 */
const NAV_ROW =
  "text-muted-foreground hover:bg-foreground/[0.04]! hover:text-foreground! active:bg-foreground/[0.07]! active:text-foreground! data-[active=true]:bg-foreground/[0.07]! data-[active=true]:text-foreground!";

/**
 * Rail collapse/expand toggle — a slim vertical pull-handle pinned to the right
 * edge at the viewport midpoint, matching the Variant-F prototype's ExpandToggle
 * (replaces the primitive's top-right PanelLeft button). The caret flips: points
 * left to collapse when expanded, right to expand when collapsed. Rendered as a
 * direct child of <Sidebar> so it anchors to the full-height fixed container.
 */
function RailToggle() {
  const { state, toggleSidebar, isMobile } = useSidebar();
  if (isMobile) return null;
  const collapsed = state === "collapsed";
  const Caret = collapsed ? CaretRightIcon : CaretLeftIcon;
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className={cn(
        "group/rail-toggle absolute top-1/2 right-[-5px] z-30 hidden h-[56px] w-[10px] -translate-y-1/2 items-center justify-center md:flex",
        "rounded-full border border-sidebar-border bg-background shadow-sm",
        "cursor-pointer transition-all duration-200 ease-out",
        "hover:w-[16px] hover:bg-muted hover:shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
      )}
    >
      <Caret
        size={10}
        weight="bold"
        aria-hidden
        className="text-muted-foreground/70 transition-colors group-hover/rail-toggle:text-foreground"
      />
    </button>
  );
}

function formatRole(role?: "admin" | "member"): string | null {
  if (role === "admin") return "Admin";
  if (role === "member") return "Member";
  return null;
}

function isNavItemActive(pathname: string, href: InternalHref): boolean {
  if (href === "/home") return pathname === "/home" || pathname === "/chat" || pathname.startsWith("/chat/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function InternalNavItem({
  item,
  active,
  badge,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label} className={NAV_ROW}>
        <Link to={item.href} onClick={onSelect}>
          <Icon size={16} aria-hidden />
          <span className="flex-1 truncate text-[13px] group-data-[collapsible=icon]:hidden">{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {badge && badge > 0 ? <SidebarMenuBadge>{badge}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  );
}

function MoreNavigation({
  items,
  pathname,
  managedUrl,
  onSelect,
}: {
  items: NavItem[];
  pathname: string;
  managedUrl?: string;
  onSelect: () => void;
}) {
  const { state, isMobile } = useSidebar();
  const hasActiveChild = items.some((item) => isNavItemActive(pathname, item.href));
  const [open, setOpen] = useState(hasActiveChild);

  useEffect(() => {
    if (hasActiveChild) setOpen(true);
  }, [hasActiveChild]);

  if (state === "collapsed" && !isMobile) {
    return (
      <SidebarGroup className="pt-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  isActive={hasActiveChild}
                  tooltip="More"
                  aria-label="More destinations"
                  className={NAV_ROW}
                >
                  <CaretDownIcon size={16} aria-hidden />
                  <span className="group-data-[collapsible=icon]:hidden">More</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-52">
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link to={item.href} onClick={onSelect}>
                        <Icon size={16} aria-hidden />
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
                {managedUrl ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <a href={managedUrl} target="_blank" rel="noopener noreferrer">
                        <ArrowSquareOutIcon size={16} aria-hidden />
                        Account
                      </a>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    );
  }

  const isOpen = open || hasActiveChild;
  return (
    <SidebarGroup className="pt-0">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={isOpen ? "Hide more destinations" : "Show more destinations"}
        onClick={() => setOpen((current) => !current)}
        className="group flex w-full items-center gap-2 py-[5px] outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span className="h-px flex-1 bg-border transition-colors group-hover:bg-foreground/25" aria-hidden />
        <span className="flex items-center gap-[3px] font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70 transition-colors group-hover:text-foreground">
          More
          <CaretDownIcon size={11} aria-hidden className={cn("transition-transform", !isOpen && "-rotate-90")} />
        </span>
        <span className="h-px flex-1 bg-border transition-colors group-hover:bg-foreground/25" aria-hidden />
      </button>
      {isOpen ? (
        <SidebarGroupContent className="mt-1">
          <SidebarMenu>
            {items.map((item) => (
              <InternalNavItem
                key={item.href}
                item={item}
                active={isNavItemActive(pathname, item.href)}
                onSelect={onSelect}
              />
            ))}
            {managedUrl ? (
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Account" className={NAV_ROW}>
                  <a href={managedUrl} target="_blank" rel="noopener noreferrer">
                    <ArrowSquareOutIcon size={16} aria-hidden />
                    <span className="flex-1 truncate text-[13px]">Account</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroupContent>
      ) : null}
    </SidebarGroup>
  );
}

function RecentsNavigation({ pathname, onSelect }: { pathname: string; onSelect: () => void }) {
  const { state, isMobile } = useSidebar();
  const conversations = useQuery({
    queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY,
    queryFn: () => api.webChat.conversations(),
    staleTime: 30_000,
  });
  const recents = useMemo(() => buildWebChatRecents(conversations.data?.conversations ?? []), [conversations.data]);

  if (state === "collapsed" && !isMobile) return null;

  return (
    <SidebarGroup className="min-h-0 flex-1 py-1">
      <SidebarGroupLabel className="font-mono text-[11px] uppercase tracking-[0.08em]">Recents</SidebarGroupLabel>
      <SidebarGroupContent className="min-h-0 overflow-y-auto">
        {conversations.isLoading ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading conversations…</p>
        ) : recents.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No recent conversations</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {recents.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                {...conversation}
                isActive={
                  conversation.builderTaskId
                    ? pathname === `/scheduled-tasks/${conversation.builderTaskId}/edit`
                    : pathname === `/chat/${conversation.id}`
                }
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ProfileMenu({
  displayName,
  displayIdentifier,
  role,
  onLogout,
}: {
  displayName: string;
  displayIdentifier: string;
  role?: "admin" | "member";
  onLogout: () => void;
}) {
  const { state, isMobile } = useSidebar();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const collapsed = state === "collapsed" && !isMobile;
  const initials = getInitials(displayIdentifier);
  const roleLabel = formatRole(role);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu, signed in as ${displayName}`}
          className={cn(
            "flex w-full items-center rounded-lg text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            collapsed ? "justify-center p-1" : "gap-2 px-2 py-2",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {initials}
          </span>
          {!collapsed ? (
            <>
              <span className="flex min-w-0 flex-1 flex-col text-xs leading-tight">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{displayName}</span>
                  {roleLabel ? (
                    <Badge variant="secondary" className="h-4 shrink-0 px-1.5 py-0 text-[9px] font-medium">
                      {roleLabel}
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 truncate text-muted-foreground">{displayIdentifier}</span>
              </span>
              <CaretUpDownIcon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
            </>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align={collapsed ? "center" : "start"} className="w-64">
        <div className="flex items-center gap-2 px-2 py-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {initials}
          </span>
          <span className="flex min-w-0 flex-1 flex-col text-xs">
            <span className="truncate font-medium">{displayName}</span>
            <span className="truncate text-muted-foreground">{displayIdentifier}</span>
          </span>
          {roleLabel ? (
            <Badge variant="secondary" className="h-4 px-1.5 py-0 text-[9px] font-medium">
              {roleLabel}
            </Badge>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {resolvedTheme === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as typeof theme)}>
              <DropdownMenuRadioItem value="light">
                <SunIcon size={16} /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <MoonIcon size={16} /> Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <DesktopIcon size={16} /> System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onLogout}>
          <SignOutIcon size={16} aria-hidden />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar({
  displayName,
  displayIdentifier,
  role,
}: {
  displayName: string;
  displayIdentifier: string;
  role?: "admin" | "member";
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { logoSrc } = useTheme();
  const { isMobile, setOpenMobile } = useSidebar();

  const identity = useQuery({ queryKey: ["settings", "identity"], queryFn: () => api.settings.identity() });
  const setupStatus = useQuery({ queryKey: ["setup", "status"], queryFn: () => api.setup.status() });
  const yourOrgReview = useQuery({
    queryKey: ["entity-review", "count", "all"],
    queryFn: () => api.entityReview.list({ limit: 0 }),
    enabled: role === "admin",
    refetchInterval: 30_000,
  });
  const yourOrgVerdicts = useQuery({
    queryKey: ["project-minting", "verdicts"],
    queryFn: () => api.projectMinting.listVerdicts(),
    enabled: role === "admin",
    retry: false,
    refetchInterval: 30_000,
  });
  const yourOrgBadgeCount = (yourOrgReview.data?.total ?? 0) + (yourOrgVerdicts.data?.verdicts.length ?? 0);
  const logout = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => {
      queryClient.clear();
      navigate({ to: "/login" });
    },
  });

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const pinned = PINNED_NAV.filter((item) => !item.adminOnly || role === "admin");
  const managedUrl = role === "admin" ? setupStatus.data?.managedUrl : undefined;
  const orgLabel = identity.data?.orgName ?? identity.data?.botName ?? "Sketch";

  return (
    <Sidebar collapsible="icon">
      <RailToggle />
      <SidebarHeader className="gap-2 px-2 pt-3 pb-1">
        <div className="flex h-10 items-center gap-2.5 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img src={logoSrc} alt="Sketch" className="size-7 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight group-data-[collapsible=icon]:hidden">
            {orgLabel}
          </span>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="New chat"
              className={NAV_ROW}
              onClick={() => {
                closeMobile();
                navigate({
                  to: "/chat/$conversationId",
                  params: { conversationId: createWebChatConversationId() },
                  search: { new: true },
                  viewTransition: shouldUseChatViewTransition(),
                });
              }}
            >
              <NotePencilIcon size={16} aria-hidden />
              <span className="text-[13px] group-data-[collapsible=icon]:hidden">New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Add integration" className={NAV_ROW}>
              <Link to="/integrations" onClick={closeMobile}>
                <PlusIcon size={16} aria-hidden />
                <span className="text-[13px] group-data-[collapsible=icon]:hidden">Add integration</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0 overflow-hidden">
        <SidebarGroup className="pb-1">
          <SidebarMenu>
            {pinned.map((item) => (
              <InternalNavItem
                key={item.href}
                item={item}
                active={isNavItemActive(location.pathname, item.href)}
                badge={item.yourOrgBadge ? yourOrgBadgeCount : undefined}
                onSelect={closeMobile}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <MoreNavigation items={MORE_NAV} pathname={location.pathname} managedUrl={managedUrl} onSelect={closeMobile} />
        <RecentsNavigation pathname={location.pathname} onSelect={closeMobile} />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <ProfileMenu
          displayName={displayName}
          displayIdentifier={displayIdentifier}
          role={role}
          onLogout={() => logout.mutate()}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
