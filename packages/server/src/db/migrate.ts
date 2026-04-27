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
import * as m040 from "./migrations/040-per-user-fireflies";
import type { DB } from "./schema";

export async function runMigrations(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({
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
          "040-per-user-fireflies": m040,
        };
      },
    },
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Success") {
      console.log(`Migration applied: ${result.migrationName}`);
    } else if (result.status === "Error") {
      console.error(`Migration failed: ${result.migrationName}`);
    }
  }

  if (error) {
    console.error("Migration run failed:", error);
    process.exit(1);
  }
}
