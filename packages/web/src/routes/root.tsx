import { EntityDrawer } from "@/components/entity-drawer/entity-drawer";
import { EntityPopover } from "@/components/entity-drawer/entity-popover";
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
      <EntityPopover />
      <Toaster />
    </EntityUiProvider>
  );
}
