import type { Kysely } from "kysely";
import type { Config } from "../config";
import type { AgentKnowledgeRefs, AgentOutputItemInput, AgentOutputItemRow } from "../db/repositories/agent-outputs";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";

/**
 * Context handed to {@link AgentDefinition.augmentRuntimeContext}. The engine builds
 * the shared runtime context, then lets a definition add or override fields (e.g. an
 * experimental, definition-specific data slice) before it is serialized into the user
 * message. `baseContext` is the engine-built context so a definition can transform it.
 */
export interface AgentRuntimeContextArgs {
  db: Kysely<DB>;
  config: Config;
  users: ReturnType<typeof createUserRepository>;
  userId: string;
  maxItemsPerSection: number;
  baseContext: Record<string, unknown>;
}

/**
 * Context handed to {@link AgentDefinition.onOutputSaved} after an output is persisted.
 * Lets a definition run side effects (e.g. promoting brief todos into durable tasks)
 * without baking definition-specific behavior into the generic engine.
 */
export interface AgentOutputSavedArgs {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  userId: string;
  outputId: string;
  items: AgentOutputItemInput[];
}

export type AgentStoredItem = AgentOutputItemRow & { knowledgeRefs: AgentKnowledgeRefs };

export interface AgentSectionDef {
  key: string;
  title: string;
  /** Whether the section is on for a brand-new user before any reconfiguration. */
  enabledByDefault: boolean;
  labels: readonly string[];
}

export interface AgentDefaults {
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  maxItemsPerSection: number;
}

export interface AgentApiItem {
  id: string;
  sectionKey: string;
  title: string;
  summary: string;
  priority: string;
  label: string;
  displayRef: string | null;
  actionType: string | null;
  actionLabel: string | null;
  actionPrompt: string | null;
  sourceUrl: string | null;
  knowledgeRefs: AgentKnowledgeRefs;
  sortOrder: number;
}

/**
 * Code-owned, versioned contract for a prebuilt agent. Behavior (instructions,
 * sections, labels, output shaping) lives here; per-user preferences and outputs
 * are data. Users enable and reconfigure definitions but cannot author new ones.
 */
export interface AgentDefinition {
  key: string;
  version: string;
  title: string;
  /** One-line tagline for the agents index card. */
  tagline: string;
  description: string;
  category: string;
  defaults: AgentDefaults;
  sections: AgentSectionDef[];
  allowedTools: string[];
  /** Allowed range for the per-section item cap; surfaced to the config editor. */
  itemsPerSectionRange: { min: number; max: number };
  /** When true, every output item must cite at least one known entity or file. */
  requiresKnowledgeRefs: boolean;
  /**
   * Fully static instruction string. Per-user values (enabled sections, item cap,
   * focus) are NOT interpolated here; they flow through the runtime context in the
   * user message so this string stays byte-identical across users for prompt-cache reuse.
   * `opts.experimentalFlag` may add gated guidance; when the flag is off the string
   * stays static and cache-shared.
   */
  buildInstructions(opts?: { experimentalFlag?: boolean }): string;
  /** Derive display refs, source URLs, and canonical action labels from indexed data. */
  enrichItems(db: Kysely<DB>, items: AgentOutputItemInput[]): Promise<AgentOutputItemInput[]>;
  /** Normalize a stored item into its API representation (label/action/displayRef fallbacks). */
  toApiItem(item: AgentStoredItem): AgentApiItem;
  /**
   * Optional: add or override runtime-context fields before serialization. Returns a
   * partial object merged over the engine-built context. Used for experimental,
   * definition-specific data (e.g. open durable tasks for the daily brief).
   */
  augmentRuntimeContext?(args: AgentRuntimeContextArgs): Promise<Record<string, unknown>>;
  /** Optional: side effects to run after an output is persisted (e.g. task promotion). */
  onOutputSaved?(args: AgentOutputSavedArgs): Promise<void>;
}
