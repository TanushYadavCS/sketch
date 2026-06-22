/**
 * App sidebar — navigation, branding, and user actions.
 * Follows the designer's sidebar structure with Phosphor icons.
 */
import { api } from "@/lib/api";
import {
  ArrowSquareOutIcon,
  BrainIcon,
  CalendarDotsIcon,
  CaretUpDownIcon,
  ChartBarIcon,
  ChatCircleIcon,
  DesktopIcon,
  FolderSimpleIcon,
  FoldersIcon,
  GearIcon,
  HashIcon,
  HouseIcon,
  LinkSimpleIcon,
  MoonIcon,
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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@sketch/ui/components/sidebar";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { getInitials } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";

interface NavItem {
  label: string;
  icon: React.ReactNode;
  href: string;
  disabled?: boolean;
  adminOnly?: boolean;
  memberVisibleWhenExperimental?: boolean;
  /** Render only when `setupStatus.experimentalFlag === true`. */
  experimentalOnly?: boolean;
  /** Optional render-prop for a trailing element (e.g. a count badge). */
  trailing?: React.ReactNode;
}

const allPrimaryNav: NavItem[] = [
  { label: "Home", icon: <HouseIcon size={18} />, href: "/home" },
  { label: "Agents", icon: <RobotIcon size={18} />, href: "/agents" },
  { label: "Chat", icon: <ChatCircleIcon size={18} />, href: "/chat" },
  { label: "Channels", icon: <HashIcon size={18} />, href: "/channels" },
  { label: "Files", icon: <FolderSimpleIcon size={18} />, href: "/files" },
  { label: "Projects", icon: <FoldersIcon size={18} />, href: "/projects", adminOnly: true },
  { label: "Team", icon: <UsersThreeIcon size={18} />, href: "/team" },
  { label: "Automations", icon: <CalendarDotsIcon size={18} />, href: "/scheduled-tasks" },
  { label: "Skills", icon: <BrainIcon size={18} />, href: "/skills" },
  { label: "Integrations", icon: <LinkSimpleIcon size={18} />, href: "/integrations" },
  { label: "Usage", icon: <ChartBarIcon size={18} />, href: "/usage" },
  {
    label: "Settings",
    icon: <GearIcon size={18} />,
    href: "/settings",
  },
];

function formatRole(role?: "admin" | "member"): string | null {
  if (role === "admin") return "Admin";
  if (role === "member") return "Member";
  return null;
}

function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/home") return pathname === "/home";
  if (href === "/chat") return pathname === "/chat" || pathname.startsWith("/chat/");
  return pathname === href;
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
  const { theme, resolvedTheme, setTheme, logoSrc } = useTheme();
  const queryClient = useQueryClient();

  const { data: identity } = useQuery({
    queryKey: ["settings", "identity"],
    queryFn: () => api.settings.identity(),
  });

  const { data: setupStatus } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api.setup.status(),
  });

  const experimentalEnabled = setupStatus?.experimentalFlag === true;
  const primaryNav = allPrimaryNav.filter((item) => {
    if (item.adminOnly && role !== "admin" && !(item.memberVisibleWhenExperimental && experimentalEnabled))
      return false;
    if (item.experimentalOnly && !experimentalEnabled) return false;
    return true;
  });
  const roleLabel = formatRole(role);

  const logoutMutation = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => {
      queryClient.clear();
      navigate({ to: "/login" });
    },
  });

  const initials = getInitials(displayIdentifier);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none hover:bg-transparent active:bg-transparent">
              <div className="flex size-8 shrink-0 items-center justify-center">
                <img src={logoSrc} alt="Sketch" className="size-7" />
              </div>
              <div className="flex min-w-0 flex-col text-left">
                <span className="truncate text-base font-semibold tracking-tight">{identity?.botName ?? "Sketch"}</span>
                {identity?.orgName ? (
                  <span className="truncate text-xs text-muted-foreground">{identity.orgName}</span>
                ) : null}
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryNav.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={isNavItemActive(location.pathname, item.href)}
                    onClick={() => !item.disabled && navigate({ to: item.href })}
                    disabled={item.disabled}
                    tooltip={item.label}
                  >
                    {item.icon}
                    <span className="flex-1">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {setupStatus?.managedUrl && role === "admin" ? (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Account">
                    <a href={setupStatus.managedUrl} target="_blank" rel="noopener noreferrer">
                      <ArrowSquareOutIcon size={18} />
                      <span>Account</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-12 w-full items-center gap-2 overflow-hidden rounded-md text-left text-sm outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground"
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
                {initials}
              </div>
              <div className="flex min-w-0 flex-1 flex-col text-left text-xs leading-tight">
                <span className="truncate font-medium">{displayName}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-muted-foreground">{displayIdentifier}</span>
                  {roleLabel ? (
                    <Badge variant="secondary" className="h-4 shrink-0 px-1.5 py-0 text-[10px] font-medium">
                      {roleLabel}
                    </Badge>
                  ) : null}
                </span>
              </div>
              <CaretUpDownIcon size={16} className="shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {resolvedTheme === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as "dark" | "light" | "system")}>
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
            <DropdownMenuItem onClick={() => logoutMutation.mutate()}>
              <SignOutIcon size={16} className="mr-2" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
