export * from "./run/contracts";
export { computeDuePeriodKey } from "./run/output-utils";
export { scopeKeyForRoute, sourceKeyForTarget } from "./run/routing";

import { AgentRunGenerationLayer } from "./run/generation";

/** Runs prebuilt agents while delegating configuration, targeting, output, and generation concerns to focused modules. */
export class AgentRunService extends AgentRunGenerationLayer {}
