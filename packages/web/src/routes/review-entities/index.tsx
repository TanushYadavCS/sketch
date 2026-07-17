/**
 * /review-entities — redirect shim.
 *
 * Entity review now lives on the Your Org surface (the Review tab), so this
 * legacy route redirects there to keep bookmarks and pasted links alive.
 */
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { dashboardRoute } from "../dashboard";

export const reviewEntitiesRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/review-entities",
  component: ReviewEntitiesRedirect,
});

function ReviewEntitiesRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/projects", search: { tab: "review" }, replace: true });
  }, [navigate]);
  return null;
}
