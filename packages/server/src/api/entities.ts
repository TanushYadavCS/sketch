import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { createEntityBindingRoutes } from "./entities/binding-routes";
import { createEntityMaintenanceRoutes } from "./entities/maintenance-routes";
import { createEntityMergeRoutes } from "./entities/merge-routes";
import { createEntityProfileRoutes } from "./entities/profile-routes";
import { createTaskRoutes } from "./entities/task-routes";
import type { EntityRoutesDeps } from "./entities/types";

export { _setCurrentReenrichJobForTests, _setCurrentResetJobForTests } from "./entities/jobs";
export type { EntityRoutesDeps } from "./entities/types";

export function entityRoutes(db: Kysely<DB>, deps: EntityRoutesDeps) {
  const routes = new Hono();
  routes.route("/", createEntityMaintenanceRoutes(db, deps));
  routes.route("/", createEntityMergeRoutes(db));
  routes.route("/", createEntityBindingRoutes(db));
  routes.route("/", createEntityProfileRoutes(db, deps));
  routes.route("/", createTaskRoutes(db));
  return routes;
}
