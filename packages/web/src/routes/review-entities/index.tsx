/**
 * /review-entities — redirect shim.
 *
 * ECR-03B moved the review surface inline onto Files → Entities. This
 * route now redirects to the entities tab so bookmarks and pasted links
 * don't 404. Delete this file (and route registration in router.ts)
 * after 2026-06-02 — the redirect is here for one release cycle only.
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
    navigate({ to: "/files", replace: true });
  }, [navigate]);
  return null;
}
