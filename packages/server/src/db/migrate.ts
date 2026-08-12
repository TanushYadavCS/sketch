/**
 * Programmatic migration runner using static imports.
 * Static imports instead of FileMigrationProvider so it works with tsdown bundling.
 */
import { Migrator } from "kysely";
import type { Kysely } from "kysely";
import * as m001 from "./migrations/001-initial";
import * as m002 from "./migrations/002-channels";
import * as m003 from "./migrations/003-whatsapp-auth";
import * as m004 from "./migrations/004-settings";
import * as m005 from "./migrations/005-settings-slack-llm";
import * as m006 from "./migrations/006-settings-jwt-secret";
import * as m007 from "./migrations/007-settings-smtp";
import * as m008 from "./migrations/008-email-verification";
import * as m009 from "./migrations/009-magic-link-tokens";
import * as m010 from "./migrations/010-mcp-servers";
import * as m011 from "./migrations/011-mcp-server-mode";
import * as m012 from "./migrations/012-chat-sessions";
import * as m013 from "./migrations/013-scheduled-tasks";
import * as m014 from "./migrations/014-chat-sessions-thread-key-sentinel";
import * as m015 from "./migrations/015-whatsapp-groups";
import * as m016 from "./migrations/016-user-description";
import * as m017 from "./migrations/017-outreach-messages";
import * as m018 from "./migrations/018-user-type-role-hierarchy";
import * as m019 from "./migrations/019-connectors";
import * as m020 from "./migrations/020-user-provider-identities";
import * as m021 from "./migrations/021-file-access";
import * as m022 from "./migrations/022-settings-extended";
import * as m023 from "./migrations/023-semantic-search";
import * as m024 from "./migrations/024-settings-enrichment";
import * as m025 from "./migrations/025-agent-usage";
import * as m026 from "./migrations/026-normalize-created-at";
import * as m027 from "./migrations/027-entities";
import * as m028 from "./migrations/028-backfill-admin-user";
import * as m029 from "./migrations/029-settings-model-id";
import * as m030 from "./migrations/030-inbox-messages";
import * as m031 from "./migrations/031-extend-scheduled-tasks";
import * as m032 from "./migrations/032-output-style";
import * as m033 from "./migrations/033-inbox-workflows";
import * as m034 from "./migrations/034-drop-tags-from-fts";
import * as m035 from "./migrations/035-smart-enrichment";
import * as m036 from "./migrations/036-org-context";
import * as m037 from "./migrations/037-browse-cache";
import * as m038 from "./migrations/038-sync-interval";
import * as m039 from "./migrations/039-drop-outreach-messages";
import * as m040 from "./migrations/040-user-auth-role";
import * as m041 from "./migrations/041-per-user-fireflies";
import * as m042 from "./migrations/042-agent-environment-variables";
import * as m043 from "./migrations/043-sketch-api-key";
import * as m048 from "./migrations/048-entity-mentions-composite-index";
import * as m049 from "./migrations/049-users-timezone";
import * as m050 from "./migrations/050-agent-tool-allowlist";
import * as m051 from "./migrations/051-channel-agent-binding";
import * as m052 from "./migrations/052-whatsapp-group-agent-binding";
import * as m053 from "./migrations/053-whatsapp-fallback-agent";
import * as m054 from "./migrations/054-agent-environment-variable-shares";
import * as m055 from "./migrations/055-normalize-automation-run-timestamps";
import * as m056 from "./migrations/056-scheduled-task-output-mode";
import * as m057 from "./migrations/057-entity-review-queue";
import * as m058 from "./migrations/058-entity-mentions-unique";
import * as m059 from "./migrations/059-scheduled-tasks-fresh-session-only";
import * as m060 from "./migrations/060-mention-provenance";
import * as m061 from "./migrations/061-indexed-file-facts";
import * as m062 from "./migrations/062-fact-materialization-state";
import * as m063 from "./migrations/063-entity-domains";
import * as m064 from "./migrations/064-entity-domains-seed";
import * as m065 from "./migrations/065-entity-domains-reserved-seed";
import * as m066 from "./migrations/066-entity-review-domain-candidates";
import * as m067 from "./migrations/067-relation-evidence-fact-link";
import * as m068 from "./migrations/068-entities-ai-brief";
import * as m069 from "./migrations/069-admin-can-read-all-files";
import * as m070 from "./migrations/070-file-shares";
import * as m071 from "./migrations/071-entity-shares";
import * as m072 from "./migrations/072-enrichment-retry-backoff";
import * as m073 from "./migrations/073-api-tokens";
import * as m074 from "./migrations/074-external-mcp-tool-calls";
import * as m075 from "./migrations/075-conversation-messages";
import * as m076 from "./migrations/076-slack-conversation-thread-metadata";
import * as m077 from "./migrations/077-scheduled-task-output-thread";
import * as m078 from "./migrations/078-local-devices";
import * as m079 from "./migrations/079-conversation-message-search";
import * as m080 from "./migrations/080-message-id-idempotency";
import * as m081 from "./migrations/081-email-message-metadata";
import * as m082 from "./migrations/082-email-thread-summaries";
import * as m083 from "./migrations/083-local-claude-sessions";
import * as m084 from "./migrations/084-entity-contact-points";
import * as m085 from "./migrations/085-crm-activity-rollups";
import * as m086 from "./migrations/086-local-claude-session-origin-runtime";
import * as m087 from "./migrations/087-rename-openrouter-provider";
import * as m088 from "./migrations/088-agent-run-aux-cost";
import * as m089 from "./migrations/089-mcp-oauth";
import * as m090 from "./migrations/090-orphan-entity-cleanup";
import * as m091 from "./migrations/091-cleanup-empty-relationships-and-review";
import * as m092 from "./migrations/092-teams-provider-file-scope";
import * as m093 from "./migrations/093-microsoft-oauth-settings";
import * as m094 from "./migrations/094-microsoft-oauth-tenant";
import * as m095 from "./migrations/095-entity-review-connector-identity";
import * as m096 from "./migrations/096-linear-project-entity-seeding-cleanup";
import * as m097 from "./migrations/097-clickup-project-entity-seeding-cleanup";
import * as m098 from "./migrations/098-entity-merge-ledger";
import * as m099 from "./migrations/099-review-queue-seed-handle";
import * as m100 from "./migrations/100-entity-project-bindings";
import * as m101 from "./migrations/101-entity-project-member-overrides";
import * as m102 from "./migrations/102-entity-creation-suppressions";
import * as m103 from "./migrations/103-daily-briefs";
import * as m104 from "./migrations/104-daily-brief-item-metadata";
import * as m105 from "./migrations/105-normalize-indexed-file-source-timestamps";
import * as m106 from "./migrations/106-agents";
import * as m107 from "./migrations/107-scheduled-task-builder-revisions";
import * as m108 from "./migrations/108-scheduled-task-origin-chat";
import * as m109 from "./migrations/109-scheduled-task-origin-message-id";
import * as m110 from "./migrations/110-google-calendar-provider-file-scope";
import * as m111 from "./migrations/111-settings-embedding-provider";
import * as m112 from "./migrations/112-agent-output-structured-payload";
import * as m113 from "./migrations/113-indexed-file-all-day-flag";
import * as m114 from "./migrations/114-agent-output-deliveries";
import * as m115 from "./migrations/115-whatsapp-template-mappings-and-provider-events";
import * as m116 from "./migrations/116-connector-credential-source";
import * as m117 from "./migrations/117-conversation-message-window-index";
import * as m118 from "./migrations/118-whatsapp-window-keepalives";
import * as m119 from "./migrations/119-agent-outputs-source-scope";
import * as m120 from "./migrations/120-agent-output-period-key";
import * as m121 from "./migrations/121-tasks";
import * as m122 from "./migrations/122-tasks-owner";
import * as m123 from "./migrations/123-sub-entities";
import * as m124 from "./migrations/124-tasks-assignee-name";
import * as m125 from "./migrations/125-milestone-series-and-value-signature";
import * as m126 from "./migrations/126-work-cycles";
import * as m127 from "./migrations/127-work-cycles-connector";
import * as m128 from "./migrations/128-work-cycles-connector-key";
import * as m129 from "./migrations/129-container-name-qualification";
import * as m130 from "./migrations/130-entity-provenance-tier";
import * as m131 from "./migrations/131-trunk-name-embeddings";
import * as m132 from "./migrations/132-agent-messages";
import * as m133 from "./migrations/133-chat-session-runtime";
import * as m134 from "./migrations/134-chat-session-archived-at";
import * as m135 from "./migrations/135-whatsapp-context-graph-indexing";
import * as m136 from "./migrations/136-whatsapp-slice-denoised-message-ids";
import * as m137 from "./migrations/137-whatsapp-group-participants";
import * as m138 from "./migrations/138-whatsapp-identity-candidates";
import * as m139 from "./migrations/139-tasks-proposed-assignee";
import * as m140 from "./migrations/140-retire-unassigned-agent-tasks";
import * as m141 from "./migrations/141-fact-materialization-quarantine";
import * as m142 from "./migrations/142-verdict-safe-fact-upserts";
import * as m143 from "./migrations/143-indexed-corroboration";
import * as m144 from "./migrations/144-whatsapp-gateway-queue";
import * as m145 from "./migrations/145-whatsapp-history-capture-foundation";
import * as m146 from "./migrations/146-whatsapp-history-top-up";
import * as m147 from "./migrations/147-whatsapp-backfill-graph-admission";
import * as m148 from "./migrations/148-whatsapp-pending-slices-index";
import * as m149 from "./migrations/149-whatsapp-backfill-lifecycle-durability";
import * as m150 from "./migrations/150-task-durability-steel-thread";
import * as m151 from "./migrations/151-agent-output-item-task-links";
import * as m152 from "./migrations/152-reseed-combined-durability-routes";
import * as m153 from "./migrations/153-slack-conversation-indexing";
import * as m154 from "./migrations/154-reclassify-mpim-conversations";
import * as m155 from "./migrations/155-requeue-kept-slice-reemission";
import * as m156 from "./migrations/156-operational-alerts";
import * as m157 from "./migrations/157-task-activity-events";
import * as m158 from "./migrations/158-slack-channel-participants";
import * as m159 from "./migrations/159-scheduled-task-conversations";
import * as m160 from "./migrations/160-slack-entity-lifecycle-sync";
import * as m161 from "./migrations/161-slack-roster-evidence";
import * as m162 from "./migrations/162-user-entity-links";
import * as m163 from "./migrations/163-slack-file-access-backfill-cleanup";
import * as m164 from "./migrations/164-outlook-calendar-provider-file-scope";
import * as m165 from "./migrations/165-typed-access-principals";
import * as m166 from "./migrations/166-scheduled-task-builder-locks";
import * as m167 from "./migrations/167-normalize-whatsapp-numbers";
import * as m168 from "./migrations/168-whatsapp-group-scope-authority";
import * as m169 from "./migrations/169-scheduled-task-execution-mode";
import * as m170 from "./migrations/170-question-interactions";
import * as m171 from "./migrations/171-question-interaction-active-keys";
import * as m172 from "./migrations/172-whatsapp-identity-observations";
import * as m173 from "./migrations/173-whatsapp-llm-flush-reason";
import * as m174 from "./migrations/174-whatsapp-topic-tables";
import * as m175 from "./migrations/175-whatsapp-chunk-knobs";
import * as m176 from "./migrations/176-whatsapp-open-slices";
import * as m177 from "./migrations/177-whatsapp-chunk-conversion-state";
import type { DB } from "./schema";

/**
 * Builds the Migrator against the full static migration map. Exported (not just
 * used internally by runMigrations) so tests can drive migrateTo() directly for
 * partial up/down sequencing without hand-maintaining a duplicate migration list.
 */
export function createMigrator(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          "001-initial": m001,
          "002-channels": m002,
          "003-whatsapp-auth": m003,
          "004-settings": m004,
          "005-settings-slack-llm": m005,
          "006-settings-jwt-secret": m006,
          "007-settings-smtp": m007,
          "008-email-verification": m008,
          "009-magic-link-tokens": m009,
          "010-mcp-servers": m010,
          "011-mcp-server-mode": m011,
          "012-chat-sessions": m012,
          "013-scheduled-tasks": m013,
          "014-chat-sessions-thread-key-sentinel": m014,
          "015-whatsapp-groups": m015,
          "016-user-description": m016,
          "017-outreach-messages": m017,
          "018-user-type-role-hierarchy": m018,
          "019-connectors": m019,
          "020-user-provider-identities": m020,
          "021-file-access": m021,
          "022-settings-extended": m022,
          "023-semantic-search": m023,
          "024-settings-enrichment": m024,
          "025-agent-usage": m025,
          "026-normalize-created-at": m026,
          "027-entities": m027,
          "028-backfill-admin-user": m028,
          "029-settings-model-id": m029,
          "030-inbox-messages": m030,
          "031-extend-scheduled-tasks": m031,
          "032-output-style": m032,
          "033-inbox-workflows": m033,
          "034-drop-tags-from-fts": m034,
          "035-smart-enrichment": m035,
          "036-org-context": m036,
          "037-browse-cache": m037,
          "038-sync-interval": m038,
          "039-drop-outreach-messages": m039,
          "040-user-auth-role": m040,
          "041-per-user-fireflies": m041,
          "042-agent-environment-variables": m042,
          "043-sketch-api-key": m043,
          "048-entity-mentions-composite-index": m048,
          "049-users-timezone": m049,
          "050-agent-tool-allowlist": m050,
          "051-channel-agent-binding": m051,
          "052-whatsapp-group-agent-binding": m052,
          "053-whatsapp-fallback-agent": m053,
          "054-agent-environment-variable-shares": m054,
          "055-normalize-automation-run-timestamps": m055,
          "056-scheduled-task-output-mode": m056,
          "057-entity-review-queue": m057,
          "058-entity-mentions-unique": m058,
          "059-scheduled-tasks-fresh-session-only": m059,
          "060-mention-provenance": m060,
          "061-indexed-file-facts": m061,
          "062-fact-materialization-state": m062,
          "063-entity-domains": m063,
          "064-entity-domains-seed": m064,
          "065-entity-domains-reserved-seed": m065,
          "066-entity-review-domain-candidates": m066,
          "067-relation-evidence-fact-link": m067,
          "068-entities-ai-brief": m068,
          "069-admin-can-read-all-files": m069,
          "070-file-shares": m070,
          "071-entity-shares": m071,
          "072-enrichment-retry-backoff": m072,
          "073-api-tokens": m073,
          "074-external-mcp-tool-calls": m074,
          "075-conversation-messages": m075,
          "076-slack-conversation-thread-metadata": m076,
          "077-scheduled-task-output-thread": m077,
          "078-local-devices": m078,
          "079-conversation-message-search": m079,
          "080-message-id-idempotency": m080,
          "081-email-message-metadata": m081,
          "082-email-thread-summaries": m082,
          "083-local-claude-sessions": m083,
          "084-entity-contact-points": m084,
          "085-crm-activity-rollups": m085,
          "086-local-claude-session-origin-runtime": m086,
          "087-rename-openrouter-provider": m087,
          "088-agent-run-aux-cost": m088,
          "089-mcp-oauth": m089,
          "090-orphan-entity-cleanup": m090,
          "091-cleanup-empty-relationships-and-review": m091,
          "092-teams-provider-file-scope": m092,
          "093-microsoft-oauth-settings": m093,
          "094-microsoft-oauth-tenant": m094,
          "095-entity-review-connector-identity": m095,
          "096-linear-project-entity-seeding-cleanup": m096,
          "097-clickup-project-entity-seeding-cleanup": m097,
          "098-entity-merge-ledger": m098,
          "099-review-queue-seed-handle": m099,
          "100-entity-project-bindings": m100,
          "101-entity-project-member-overrides": m101,
          "102-entity-creation-suppressions": m102,
          "103-daily-briefs": m103,
          "104-daily-brief-item-metadata": m104,
          "105-normalize-indexed-file-source-timestamps": m105,
          "106-agents": m106,
          "107-scheduled-task-builder-revisions": m107,
          "108-scheduled-task-origin-chat": m108,
          "109-scheduled-task-origin-message-id": m109,
          "110-google-calendar-provider-file-scope": m110,
          "111-settings-embedding-provider": m111,
          "112-agent-output-structured-payload": m112,
          "113-indexed-file-all-day-flag": m113,
          "114-agent-output-deliveries": m114,
          "115-whatsapp-template-mappings-and-provider-events": m115,
          "116-connector-credential-source": m116,
          "117-conversation-message-window-index": m117,
          "118-whatsapp-window-keepalives": m118,
          "119-agent-outputs-source-scope": m119,
          "120-agent-output-period-key": m120,
          "121-tasks": m121,
          "122-tasks-owner": m122,
          "123-sub-entities": m123,
          "124-tasks-assignee-name": m124,
          "125-milestone-series-and-value-signature": m125,
          "126-work-cycles": m126,
          "127-work-cycles-connector": m127,
          "128-work-cycles-connector-key": m128,
          "129-container-name-qualification": m129,
          "130-entity-provenance-tier": m130,
          "131-trunk-name-embeddings": m131,
          "132-agent-messages": m132,
          "133-chat-session-runtime": m133,
          "134-chat-session-archived-at": m134,
          "135-whatsapp-context-graph-indexing": m135,
          "136-whatsapp-slice-denoised-message-ids": m136,
          "137-whatsapp-group-participants": m137,
          "138-whatsapp-identity-candidates": m138,
          "139-tasks-proposed-assignee": m139,
          "140-retire-unassigned-agent-tasks": m140,
          "141-fact-materialization-quarantine": m141,
          "142-verdict-safe-fact-upserts": m142,
          "143-indexed-corroboration": m143,
          "144-whatsapp-gateway-queue": m144,
          "145-whatsapp-history-capture-foundation": m145,
          "146-whatsapp-history-top-up": m146,
          "147-whatsapp-backfill-graph-admission": m147,
          "148-whatsapp-pending-slices-index": m148,
          "149-whatsapp-backfill-lifecycle-durability": m149,
          "150-task-durability-steel-thread": m150,
          "151-agent-output-item-task-links": m151,
          "152-reseed-combined-durability-routes": m152,
          "153-slack-conversation-indexing": m153,
          "154-reclassify-mpim-conversations": m154,
          "155-requeue-kept-slice-reemission": m155,
          "156-operational-alerts": m156,
          "157-task-activity-events": m157,
          "158-slack-channel-participants": m158,
          "159-scheduled-task-conversations": m159,
          "160-slack-entity-lifecycle-sync": m160,
          "161-slack-roster-evidence": m161,
          "162-user-entity-links": m162,
          "163-slack-file-access-backfill-cleanup": m163,
          "164-outlook-calendar-provider-file-scope": m164,
          "165-typed-access-principals": m165,
          "166-scheduled-task-builder-locks": m166,
          "167-normalize-whatsapp-numbers": m167,
          "168-whatsapp-group-scope-authority": m168,
          "169-scheduled-task-execution-mode": m169,
          "170-question-interactions": m170,
          "171-question-interaction-active-keys": m171,
          "172-whatsapp-identity-observations": m172,
          "173-whatsapp-llm-flush-reason": m173,
          "174-whatsapp-topic-tables": m174,
          "175-whatsapp-chunk-knobs": m175,
          "176-whatsapp-open-slices": m176,
          "177-whatsapp-chunk-conversion-state": m177,
        };
      },
    },
  });
}

export async function runMigrations(db: Kysely<DB>, options?: { quiet?: boolean }): Promise<void> {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Success") {
      if (!options?.quiet) console.log(`Migration applied: ${result.migrationName}`);
    } else if (result.status === "Error") {
      console.error(`Migration failed: ${result.migrationName}`);
    }
  }

  if (error) {
    console.error("Migration run failed:", error);
    process.exit(1);
  }
}
