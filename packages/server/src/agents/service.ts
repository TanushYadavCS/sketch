export * from "./service-contracts";
export { computeDuePeriodKey } from "./service-output-utils";
export { scopeKeyForRoute, sourceKeyForTarget } from "./service-routing";

import { AgentGenerationService } from "./service-generation";

/** Runs prebuilt agents while delegating configuration, targeting, output, and generation concerns to focused modules. */
export class AgentRunService extends AgentGenerationService {}
