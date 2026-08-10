import type { Kysely } from "kysely";

type MigrationDb = {
  connector_configs: { id: string; connector_type: string; scope_config: string };
  whatsapp_groups: { jid: string; index_enabled: number };
};

function parseScope(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const migrationDb = db as Kysely<MigrationDb>;
  const configs = await migrationDb
    .selectFrom("connector_configs")
    .select(["id", "scope_config"])
    .where("connector_type", "=", "whatsapp")
    .execute();

  for (const config of configs) {
    const scope = parseScope(config.scope_config);
    if (!scope || !Object.hasOwn(scope, "groupJids")) continue;
    const { groupJids: _groupJids, ...scopeWithoutGroups } = scope;
    await migrationDb
      .updateTable("connector_configs")
      .set({ scope_config: JSON.stringify(scopeWithoutGroups) })
      .where("id", "=", config.id)
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const migrationDb = db as Kysely<MigrationDb>;
  const enabledGroups = await migrationDb
    .selectFrom("whatsapp_groups")
    .select("jid")
    .where("index_enabled", "=", 1)
    .orderBy("jid", "asc")
    .execute();
  const enabledJids = enabledGroups.map((group) => group.jid);
  const configs = await migrationDb
    .selectFrom("connector_configs")
    .select(["id", "scope_config"])
    .where("connector_type", "=", "whatsapp")
    .execute();

  for (const config of configs) {
    const scope = parseScope(config.scope_config);
    if (!scope) continue;
    await migrationDb
      .updateTable("connector_configs")
      .set({ scope_config: JSON.stringify({ ...scope, groupJids: enabledJids }) })
      .where("id", "=", config.id)
      .execute();
  }
}
