import { AppSidebar } from "@/components/app-sidebar";
import { api } from "@/lib/api";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@sketch/ui/components/sidebar";
import { Outlet, createRoute, redirect, useRouteContext } from "@tanstack/react-router";
import { redirectToManagedLogin } from "./managed-redirect";
import { rootRoute } from "./root";

export interface AuthContext {
  role?: "admin" | "member";
  email?: string;
  userId?: string;
  name?: string;
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
    <SidebarProvider>
      <AppSidebar displayName={auth.displayName} displayIdentifier={auth.displayIdentifier} role={auth.role} />
      <SidebarInset>
        <SidebarTrigger className="absolute left-3 top-3 z-20" />
        <main className="flex-1 overflow-auto pt-[52px]">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
