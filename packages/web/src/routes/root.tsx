import { EntityDrawer } from "@/components/entity-drawer/entity-drawer";
import { EntityUiProvider } from "@/lib/entity-ui";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Toaster } from "sonner";

export const rootRoute = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <EntityUiProvider>
      <Outlet />
      <EntityDrawer />
      <Toaster />
    </EntityUiProvider>
  );
}
