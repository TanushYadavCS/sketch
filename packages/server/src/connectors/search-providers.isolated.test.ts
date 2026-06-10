import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { search } from "./search";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("search provider fallback", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.destroy();
  });

  it("uses the decrypted OpenRouter settings key for query embeddings when Gemini is not configured", async () => {
    const settings = createSettingsRepository(db, TEST_KEY);
    await settings.ensure();
    await settings.update({
      llmProvider: "openrouter",
      anthropicApiKey: "sk-or-db",
      modelId: "openrouter/chat-model",
      geminiApiKey: null,
      enrichmentEnabled: 1,
    });

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ error: { message: "stop after provider selection" } }, { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await search(db, "habuild fireflies", {
      openRouterApiKey: "sk-or-env",
      settingsEncryptionKey: TEST_KEY,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk-or-db",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "google/gemini-embedding-2-preview",
      input: ["habuild fireflies"],
      dimensions: 3072,
    });
  });
});
