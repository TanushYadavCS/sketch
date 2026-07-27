import type { AgentRuntimeProviderFactoryConfig } from "../../agent/runtime/contracts";
import { type AgentRuntimeProvider, createAgentRuntimeProvider } from "../../agent/runtime/provider";

export type AutomationAuthoringProviderErrorCode = "PROVIDER_UNAVAILABLE" | "OPENROUTER_REQUIRED";

export class AutomationAuthoringProviderError extends Error {
  readonly code: AutomationAuthoringProviderErrorCode;

  constructor(code: AutomationAuthoringProviderErrorCode, message: string) {
    super(message);
    this.name = "AutomationAuthoringProviderError";
    this.code = code;
  }
}

export interface AutomationAuthoringProviderLoaderConfig {
  modelId: string;
  loadProviderConfig: () => Promise<AgentRuntimeProviderFactoryConfig | null>;
}

export type OpenRouterAutomationAuthoringProvider = AgentRuntimeProvider & { provider: "openrouter" };

export function createAutomationAuthoringProviderLoader(
  config: AutomationAuthoringProviderLoaderConfig,
): () => Promise<OpenRouterAutomationAuthoringProvider>;
export function createAutomationAuthoringProviderLoader<T>(
  config: AutomationAuthoringProviderLoaderConfig,
  deps: {
    createProvider: (providerConfig: AgentRuntimeProviderFactoryConfig) => T;
  },
): () => Promise<T>;
export function createAutomationAuthoringProviderLoader<T>(
  config: AutomationAuthoringProviderLoaderConfig,
  deps: {
    createProvider: (providerConfig: AgentRuntimeProviderFactoryConfig) => T;
  } = {
    createProvider: createAgentRuntimeProvider as (providerConfig: AgentRuntimeProviderFactoryConfig) => T,
  },
): () => Promise<T> {
  return async () => {
    const providerConfig = await config.loadProviderConfig();
    if (!providerConfig) {
      throw new AutomationAuthoringProviderError(
        "PROVIDER_UNAVAILABLE",
        "Automation authoring requires a complete OpenRouter provider configuration",
      );
    }
    if (providerConfig.provider !== "openrouter") {
      throw new AutomationAuthoringProviderError(
        "OPENROUTER_REQUIRED",
        "Automation authoring is configured but the active LLM provider is not OpenRouter",
      );
    }
    return deps.createProvider({
      ...providerConfig,
      modelId: config.modelId,
    });
  };
}
