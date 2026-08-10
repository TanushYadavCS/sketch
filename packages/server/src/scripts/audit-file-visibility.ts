import { createHash } from "node:crypto";
import pino from "pino";
import { signJwt } from "../auth/jwt";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import { createSettingsRepository } from "../db/repositories/settings";
import { createApp } from "../http";

interface AllFilesResponse {
  files: Array<{ id: string }>;
  hasMore: boolean;
}

const PAGE_SIZE = 200;

async function listVisibleFileIds(app: ReturnType<typeof createApp>, cookie: string): Promise<string[]> {
  const fileIds = new Set<string>();
  let offset = 0;

  while (true) {
    const response = await app.request(`/api/connectors/all-files?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: { Cookie: cookie },
    });
    if (response.status !== 200) {
      throw new Error(`all-files returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as AllFilesResponse;
    for (const file of body.files) fileIds.add(file.id);
    if (!body.hasMore) break;
    offset += PAGE_SIZE;
  }

  return [...fileIds].sort();
}

async function main(): Promise<void> {
  const config = loadConfig();
  validateConfig(config);
  const db = await createDatabase(config);

  try {
    const settings = await createSettingsRepository(db, config.ENCRYPTION_KEY).get();
    if (!settings?.jwt_secret) throw new Error("The database has no JWT secret");

    const app = createApp(db, config, { logger: pino({ level: "silent" }) });
    const users = await db.selectFrom("users").select(["id", "name", "auth_role"]).orderBy("id", "asc").execute();

    for (const user of users) {
      const role = user.auth_role === "admin" ? "admin" : "member";
      const token = await signJwt(user.id, role, settings.jwt_secret);
      const fileIds = await listVisibleFileIds(app, `sketch_session=${token}`);
      const digest = createHash("sha256").update(fileIds.join("\n")).digest("hex");
      console.log(`${user.id}\t${JSON.stringify(user.name)}\t${fileIds.length}\t${digest}`);
    }
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
