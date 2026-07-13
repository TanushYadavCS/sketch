import { loadConfig, validateConfig } from "../src/config";
import { reconcileMissingNameEmbeddings } from "../src/connectors/embeddings/trunk-name-embeddings";
import {
  createEnrichmentEmbeddingProvider,
  resolveOpenRouterEnrichmentConfig,
} from "../src/connectors/enrichment-providers";
import { createDatabase } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import { createSettingsRepository } from "../src/db/repositories/settings";
import { createLogger } from "../src/logger";

async function main() {
  const config = loadConfig();
  validateConfig(config);
  const logger = createLogger(config);
  const db = await createDatabase(config);

  try {
    await runMigrations(db, { quiet: true });
    const settings = await createSettingsRepository(db, config.ENCRYPTION_KEY).get();
    const openRouterConfig = resolveOpenRouterEnrichmentConfig(settings, config.OPENROUTER_API_KEY);
    const provider = createEnrichmentEmbeddingProvider({
      geminiApiKey: settings?.gemini_api_key,
      geminiMaxRpm: config.GEMINI_MAX_RPM,
      geminiMaxRetries: config.GEMINI_MAX_RETRIES,
      logger,
      ...openRouterConfig,
    });

    await reconcileMissingNameEmbeddings(db, provider);
    logger.info({ provider: provider?.name ?? null }, "trunk name embedding backfill complete");
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
