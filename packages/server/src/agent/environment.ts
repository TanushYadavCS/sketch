import { isReservedAgentEnvName } from "@sketch/shared";

export { isReservedAgentEnvName };

export function removeReservedAgentEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isReservedAgentEnvName(name)));
}
