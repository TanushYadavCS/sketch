import {
  type CliIntegrationAppDefinition,
  type CliIntegrationAppId,
  cliIntegrationAppDefinition,
  cliIntegrationAppDefinitions,
} from "@sketch/shared";

export const CLI_INTEGRATION_REGISTRY: Readonly<Record<CliIntegrationAppId, CliIntegrationAppDefinition>> =
  cliIntegrationAppDefinitions;

export function getCliIntegrationDefinition(appId: string): CliIntegrationAppDefinition | null {
  return cliIntegrationAppDefinition(appId);
}

export function listCliIntegrationDefinitions(query?: string): CliIntegrationAppDefinition[] {
  const normalized = query?.trim().toLowerCase() ?? "";
  return Object.values(CLI_INTEGRATION_REGISTRY).filter((definition) => {
    if (!normalized) return true;
    return [definition.id, definition.name, definition.description].some((value) =>
      value.toLowerCase().includes(normalized),
    );
  });
}

export function cliIntegrationRequiredEnv(appId: string): string[] {
  return getCliIntegrationDefinition(appId)?.credentialFields.map((field) => field.envName) ?? [];
}
