import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { rewriteLearnedFacts, validateLearnedFact, validateLlmMention } from "./validators";

describe("validateLlmMention", () => {
  it("rejects LLM names absent from file content", () => {
    expect(
      validateLlmMention({
        displayName: "Atlas",
        fileContent: "Sarah discussed the renewal plan.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: false, reason: "name_absent_from_content" });
  });

  it("rejects short tokens without a word boundary", () => {
    expect(
      validateLlmMention({
        displayName: "Al",
        fileContent: "Algorithm planning notes",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: false, reason: "short_token_no_boundary" });
  });

  it("accepts project LLM entity types", () => {
    expect(
      validateLlmMention({
        displayName: "Aviation Edge Migration",
        entityType: "project",
        fileContent: "Aviation Edge Migration was discussed.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects domain-shaped LLM names while preserving normal project names", () => {
    expect(
      validateLlmMention({
        displayName: "beaconvendor.com",
        entityType: "project",
        fileContent: "The team reviewed beaconvendor.com during planning.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: false, reason: "name_is_domain_or_url" });
    expect(
      validateLlmMention({
        displayName: "Maaden Dashboard",
        entityType: "project",
        fileContent: "Maaden Dashboard is ready for stakeholder review.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: true });
  });

  it("permits connector extracted facts whose display name is absent", () => {
    expect(
      validateLlmMention({
        displayName: "Calendar Owner",
        fileContent: "Meeting notes",
        source: "connector_extracted",
      }),
    ).toEqual({ ok: true });
  });

  it("permits LLM names when source content only differs by punctuation", () => {
    expect(
      validateLlmMention({
        displayName: "Acme Inc",
        fileContent: "The renewal is with Acme, Inc.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: true });
    expect(
      validateLlmMention({
        displayName: "R Nijhara",
        fileContent: "R. Nijhara joined the discussion.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: true });
  });

  it("permits thread-resolved references only when the current content has a real reference", () => {
    expect(
      validateLlmMention({
        displayName: "Alice Patel",
        fileContent: "She confirmed Tuesday for the onboarding review.",
        resolutionContext: "Alice Patel proposed Tuesday for the onboarding review.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: true });

    expect(
      validateLlmMention({
        displayName: "Alice Patel",
        fileContent: "Yes, that works for Tuesday.",
        resolutionContext: "Alice Patel proposed Tuesday for the onboarding review.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: false, reason: "missing_current_reference" });

    expect(
      validateLlmMention({
        displayName: "Alice Patel",
        fileContent: "ok",
        resolutionContext: "Alice Patel proposed Tuesday for the onboarding review.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: false, reason: "missing_current_reference" });

    expect(
      validateLlmMention({
        displayName: "Alice Patel",
        fileContent: "Lunch menu attached.",
        resolutionContext: "Alice Patel proposed Tuesday for the onboarding review.",
        source: "llm_extraction",
      }),
    ).toEqual({ ok: false, reason: "missing_current_reference" });
  });
});

describe("validateLearnedFact", () => {
  it("rejects junk learned facts", () => {
    expect(validateLearnedFact("not mentioned in the document").ok).toBe(false);
    expect(validateLearnedFact("is likely a CEO").ok).toBe(false);
    expect(validateLearnedFact("[unknown title]").ok).toBe(false);
    expect(validateLearnedFact("Head of sales?").ok).toBe(false);
  });
});

describe("rewriteLearnedFacts", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("rewrites and removes learned facts idempotently", async () => {
    const entityRepo = createEntityRepository(db);
    const entity = await entityRepo.upsertEntity({
      name: "Canvas",
      sourceType: "company",
      metadata: {
        learned_facts: [{ fact: "is likely a client" }, { fact: "uses Sketch" }],
      },
    });

    const result = await rewriteLearnedFacts({ entityRepo, logger: createTestLogger() }, entity.id, (value) => {
      if (!validateLearnedFact(value).ok) return null;
      return value.replace("Sketch", "Sketch AI");
    });

    expect(result).toEqual({ updated: 1, removed: 1 });
    const updated = await entityRepo.getEntity(entity.id);
    const metadata = JSON.parse(updated?.metadata ?? "{}");
    expect(metadata.learned_facts).toEqual([{ fact: "uses Sketch AI" }]);

    const second = await rewriteLearnedFacts({ entityRepo, logger: createTestLogger() }, entity.id, (value) => value);
    expect(second).toEqual({ updated: 0, removed: 0 });
  });
});
