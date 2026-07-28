import { AppSidebar } from "@/components/app-sidebar";
import { api } from "@/lib/api";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@sketch/ui/components/sidebar";
import { Outlet, createRoute, redirect, useRouteContext } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { redirectToManagedLogin } from "./managed-redirect";
import { rootRoute } from "./root";

export interface AuthContext {
  role?: "admin" | "member";
  email?: string;
  userId?: string;
  name?: string;
  managedUrl?: string;
  displayName: string;
  displayIdentifier: string;
}

/**
 * Auth guard: checks setup status first, then session.
 * If setup not complete → /onboarding.
 * If not authenticated → /login.
 */
function safeReturnTo(value: string | undefined): string | null {
  if (!value?.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/login")) return null;
  return value;
}

function loginRedirect(returnTo: string | null): never {
  const loginUrl = returnTo ? `/login?return_to=${encodeURIComponent(returnTo)}` : "/login";
  throw redirect({ href: loginUrl });
}

async function checkAuth(returnTo?: string): Promise<{ auth: AuthContext }> {
  const status = await api.setup.status();
  if (!status.completed) {
    throw redirect({ to: "/onboarding" });
  }

  const session = await api.auth.session();
  if (!session.authenticated) {
    const safeTarget = safeReturnTo(returnTo);
    if (status.managedUrl) {
      redirectToManagedLogin(status.managedUrl, safeTarget);
    }
    loginRedirect(safeTarget);
  }

  return {
    auth: {
      role: session.role,
      email: session.email,
      userId: session.userId,
      name: session.name,
      managedUrl: status.managedUrl,
      displayName: session.name ?? "User",
      displayIdentifier: session.email ?? session.name ?? "User",
    },
  };
}

export function useDashboardAuth(): AuthContext {
  const { auth } = useRouteContext({ from: dashboardRoute.id }) as { auth: AuthContext };
  return auth;
}

export const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "dashboard",
  beforeLoad: async ({ location }) => {
    return await checkAuth(location.href);
  },
  component: DashboardLayout,
});

function DashboardLayout() {
  const auth = useDashboardAuth();

  return (
    <SidebarProvider
      defaultOpen={sidebarDefaultOpen()}
      style={
        {
          "--sidebar-width": "16rem",
          "--sidebar-width-icon": "3rem",
        } as CSSProperties
      }
    >
      <AppSidebar displayName={auth.displayName} displayIdentifier={auth.displayIdentifier} role={auth.role} />
      <SidebarInset>
        <div className="flex h-12 shrink-0 items-center border-b px-3 md:hidden">
          <SidebarTrigger />
        </div>
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function sidebarDefaultOpen(cookie = typeof document === "undefined" ? "" : document.cookie): boolean {
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("sidebar_state="))
    ?.slice("sidebar_state=".length);
  return value !== "false";
}
