import type { Kysely } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import type { DB } from "../db/schema";
import { createSingleFlight } from "../lib/single-flight";
import { createTestDb } from "../test-utils";
import { computeInputHash, generateAiBrief, loadCachedBrief, markBriefStale } from "./ai-brief";
import type { EntityProfileFacts } from "./profile-facts";

const logger = pino({ level: "silent" });

function factsFor(entityId: string): EntityProfileFacts {
  return {
    entityId,
    name: "Sarah",
    sourceType: "person",
    entityType: "person",
    metadata: { role: "Engineer" },
    mentionCount: 8,
    sourceCounts: { fireflies: 5, google_drive: 3 },
    firstSeenAt: "2026-04-01T00:00:00.000Z",
    lastSeenAt: "2026-05-22T00:00:00.000Z",
    domainsForCompany: [],
    topRelationships: [],
    incomingCounts: {},
    outgoingCounts: {},
  };
}

function makeGemini(impl: (prompt: string) => Promise<unknown>): { gen: GeminiGenerator; calls: { count: number } } {
  const calls = { count: 0 };
  const generateJSON = vi.fn(async (prompt: string) => {
    calls.count += 1;
    return impl(prompt) as never;
  });
  const generate = vi.fn(async () => "");
  return { gen: { generate, generateJSON } as unknown as GeminiGenerator, calls };
}

async function seedEntity(db: Kysely<DB>, id: string) {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name: "Sarah",
      source_type: "person",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

describe("generateAiBrief", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("parses Gemini JSON, persists ai_brief, returns inputHash", async () => {
    await seedEntity(db, "e1");
    const { gen, calls } = makeGemini(async () => ({
      signal: "Mostly Atlas standups lately.",
      soWhat: "Quick check-in on Helios direction?",
    }));
    const sf = createSingleFlight();
    const result = await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, factsFor("e1"));
    expect(result.cached).toBe(false);
    expect(result.signal).toBe("Mostly Atlas standups lately.");
    expect(result.soWhat).toBe("Quick check-in on Helios direction?");
    expect(result.inputHash).toBeTruthy();
    expect(calls.count).toBe(1);

    const cached = await loadCachedBrief(db, "e1");
    expect(cached?.signal).toBe("Mostly Atlas standups lately.");
    expect(cached?.inputHash).toBe(result.inputHash);
  });

  it("returns cached brief without calling Gemini when inputs unchanged", async () => {
    await seedEntity(db, "e1");
    const { gen, calls } = makeGemini(async () => ({ signal: "S1", soWhat: "SW1" }));
    const sf = createSingleFlight();
    const facts = factsFor("e1");
    await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, facts);
    const repeat = await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, facts);
    expect(repeat.cached).toBe(true);
    expect(calls.count).toBe(1);
  });

  it("regenerates when inputs change", async () => {
    await seedEntity(db, "e1");
    const { gen, calls } = makeGemini(async () => ({ signal: "S", soWhat: "SW" }));
    const sf = createSingleFlight();
    await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, factsFor("e1"));
    const changed = { ...factsFor("e1"), mentionCount: 99 };
    await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, changed);
    expect(calls.count).toBe(2);
  });

  it("returns empty brief with generation_failed when Gemini throws", async () => {
    await seedEntity(db, "e1");
    const { gen } = makeGemini(async () => {
      throw new Error("network blip");
    });
    const sf = createSingleFlight();
    const result = await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, factsFor("e1"));
    expect(result.signal).toBeNull();
    expect(result.soWhat).toBeNull();
    expect(result.error).toBe("generation_failed");
  });

  it("collapses two concurrent calls into one Gemini invocation", async () => {
    await seedEntity(db, "e1");
    const { gen, calls } = makeGemini(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { signal: "S", soWhat: "SW" };
    });
    const sf = createSingleFlight();
    const facts = factsFor("e1");
    const [a, b] = await Promise.all([
      generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, facts),
      generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, facts),
    ]);
    expect(calls.count).toBe(1);
    expect(a.signal).toBe("S");
    expect(b.signal).toBe("S");
  });

  it("org-shared cache: a second caller reads the persisted brief without another Gemini call", async () => {
    await seedEntity(db, "e1");
    const { gen, calls } = makeGemini(async () => ({ signal: "S", soWhat: "SW" }));
    const sf = createSingleFlight();
    await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, factsFor("e1"));
    // Different singleFlight (e.g. fresh request lifetime) — cache is in DB, not in the SF.
    const sf2 = createSingleFlight();
    const second = await generateAiBrief({ db, gemini: gen, singleFlight: sf2, logger }, factsFor("e1"));
    expect(second.cached).toBe(true);
    expect(calls.count).toBe(1);
  });

  it("markBriefStale flips the persisted stale flag and force regenerates", async () => {
    await seedEntity(db, "e1");
    const { gen, calls } = makeGemini(async () => ({ signal: "S", soWhat: "SW" }));
    const sf = createSingleFlight();
    await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, factsFor("e1"));
    await markBriefStale(db, "e1");
    const stale = await loadCachedBrief(db, "e1");
    expect(stale?.stale).toBe(true);

    const forced = await generateAiBrief({ db, gemini: gen, singleFlight: sf, logger }, factsFor("e1"), {
      force: true,
    });
    expect(calls.count).toBe(2);
    expect(forced.stale).toBe(false);
  });

  it("inputHash is deterministic for the same facts", () => {
    const a = computeInputHash(factsFor("e1"));
    const b = computeInputHash(factsFor("e1"));
    expect(a).toBe(b);
  });
});
