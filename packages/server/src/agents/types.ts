import type { Kysely } from "kysely";
import type { Selectable } from "kysely";
import type {
  AgentDeliveryConfig,
  AgentKnowledgeRefs,
  AgentOutputItemInput,
  AgentSourceConfig,
  AgentStoredItemRow,
  AgentStructuredPayload,
} from "../db/repositories/agent-outputs";
import type { DB, UsersTable } from "../db/schema";

export type AgentStoredItem = AgentStoredItemRow;

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

export interface AgentSourceConfigDef {
  maxSources: number;
  supportsSlackChannels: boolean;
  supportsWhatsAppGroups: boolean;
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
  structuredPayload: AgentStructuredPayload | null;
  knowledgeRefs: AgentKnowledgeRefs;
  sortOrder: number;
}

export interface AgentRuntimeContextParams {
  db: Kysely<DB>;
  user: Selectable<UsersTable>;
  outputDate: string;
  timezone: string;
  now: Date;
  adminCanReadAllFiles: boolean;
  contentUserEmails: string[] | undefined;
  agentConfig?: {
    enabledSections: Record<string, boolean>;
    maxItemsPerSection: number;
    focus: string | null;
    delivery: AgentDeliveryConfig | null;
    sources: AgentSourceConfig[];
    sourceKey: string;
    firstRunLookbackHours?: number;
  };
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
  sourceConfig?: AgentSourceConfigDef;
  allowedTools: string[];
  /** Allowed range for the per-section item cap; surfaced to the config editor. */
  itemsPerSectionRange: { min: number; max: number };
  /** When true, every output item must cite at least one known entity or file. */
  requiresKnowledgeRefs: boolean;
  /**
   * Fully static instruction string. Per-user values (enabled sections, item cap,
   * focus) are NOT interpolated here; they flow through the runtime context in the
   * user message so this string stays byte-identical across users for prompt-cache reuse.
   */
  buildInstructions(): string;
  /** Derive display refs, source URLs, and canonical action labels from indexed data. */
  enrichItems(db: Kysely<DB>, items: AgentOutputItemInput[]): Promise<AgentOutputItemInput[]>;
  /** Optional per-definition runtime context appended to the agent run JSON. */
  buildRuntimeContext?(params: AgentRuntimeContextParams): Promise<Record<string, unknown>>;
  /**
   * Optional pass over the emitted items before enrichment/validation. Used by
   * sections whose canonical content is deterministic (e.g. meetings, where the
   * list comes from the calendar, not the model): reconcile the model's items
   * against the server-built skeleton in `runtimeContext` so nothing is invented,
   * dropped, or has its identity fields overwritten by the model.
   */
  reconcileItems?(params: {
    db: Kysely<DB>;
    items: AgentOutputItemInput[];
    runtimeContext: Record<string, unknown>;
  }): Promise<AgentOutputItemInput[]>;
  /** Normalize a stored item into its API representation (label/action/displayRef fallbacks). */
  toApiItem(item: AgentStoredItem): AgentApiItem;
}
