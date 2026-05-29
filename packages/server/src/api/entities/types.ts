import type { Logger } from "pino";
import type { Config } from "../../config";
import type { ReenrichScope } from "../../entities/reenrich";

export interface EntityRoutesDeps {
  logger: Logger;
  config: Config;
}

export interface ReenrichRequest {
  scope: ReenrichScope;
  runAfter: boolean;
}

export interface RebuildRequest {
  pendingRebuildId: string;
}
