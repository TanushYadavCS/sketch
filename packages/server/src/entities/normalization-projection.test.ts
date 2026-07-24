import { describe, expect, it } from "vitest";
import { coerceMentionType, normalizeMentionType } from "./graph";
import { normalizeEntityMatchName } from "./match-normalize";
import { projectFeatureCorroborationKey, projectLlmExtractedNormalization } from "./normalization-projection";

/**
 * The projection columns must reproduce each legacy consumer's exact key:
 * `buildActiveLlmFileCounts` (raw type + subject), `findLlmExtractedThirdPartyMention`
 * (raw type + mention/subject), and `materializeLlmExtractedFact` (coerced type).
 * These helpers recompute those legacy keys inline so a formula drift fails here.
 */
function legacyCountMapType(raw: Record<string, unknown>): string | null {
  return normalizeMentionType(raw.type);
}
function legacyCountMapName(raw: Record<string, unknown>, subject: string): string | null {
  const type = normalizeMentionType(raw.type);
  return type ? normalizeEntityMatchName(type, subject) || null : null;
}
function legacyThirdPartyName(raw: Record<string, unknown>, subject: string): string {
  const type = normalizeMentionType(raw.type);
  const mention = typeof raw.mention === "string" ? raw.mention : subject;
  return normalizeEntityMatchName(type ?? "", mention);
}
function legacyMaterializerType(raw: Record<string, unknown>, subject: string): string | null {
  return normalizeMentionType(coerceMentionType(subject, String(raw.type ?? "")));
}

describe("projectLlmExtractedNormalization", () => {
  const cases: Array<{ name: string; subject: string; raw: Record<string, unknown> }> = [
    { name: "person with surrounding whitespace and mixed case", subject: "  Alice SMITH ", raw: { type: "Person" } },
    { name: "company with distinct mention", subject: "Acme", raw: { type: "company", mention: "Acme Corp" } },
    { name: "missing raw.mention falls back to subject", subject: "Globex", raw: { type: "company" } },
    { name: "product digit/letter normalization", subject: "iPhone13-Pro", raw: { type: "product" } },
    { name: "team mention type", subject: "Platform Team", raw: { type: "team" } },
    { name: "deal mention type", subject: "Q3 Renewal", raw: { type: "deal" } },
    { name: "tool mention type", subject: "Datadog", raw: { type: "tool" } },
    { name: "project mention type", subject: "Atlas", raw: { type: "project" } },
    { name: "denylisted tool name typed as company coerces to tool", subject: "Slack", raw: { type: "company" } },
    { name: "denylisted name with explicit mention", subject: "Jira", raw: { type: "company", mention: "Jira Cloud" } },
    { name: "unknown mention type", subject: "Mystery", raw: { type: "banana" } },
    { name: "absent mention type", subject: "Nameless", raw: {} },
  ];

  for (const { name, subject, raw } of cases) {
    it(`matches every legacy consumer key: ${name}`, () => {
      const projection = projectLlmExtractedNormalization(subject, raw);
      expect(projection.raw_mention_type).toBe(legacyCountMapType(raw));
      expect(projection.normalized_subject_name).toBe(legacyCountMapName(raw, subject));
      expect(projection.normalized_mention_name).toBe(legacyThirdPartyName(raw, subject) || null);
      expect(projection.mention_type).toBe(legacyMaterializerType(raw, subject));
    });
  }

  it("persists the denylist divergence between count key and materializer type", () => {
    const projection = projectLlmExtractedNormalization("Slack", { type: "company" });
    expect(projection.raw_mention_type).toBe("company");
    expect(projection.normalized_subject_name).toBe("slack");
    expect(projection.mention_type).toBe("tool");
  });
});

describe("projectFeatureCorroborationKey", () => {
  it("returns the key only for LLM feature sources with a string key", () => {
    expect(projectFeatureCorroborationKey("llm_extraction", { corroborationKey: "k1" })).toBe("k1");
    expect(projectFeatureCorroborationKey("llm", { corroborationKey: "k2" })).toBe("k2");
    expect(projectFeatureCorroborationKey("structural", { corroborationKey: "k3" })).toBeNull();
    expect(projectFeatureCorroborationKey("llm_extraction", {})).toBeNull();
    expect(projectFeatureCorroborationKey("llm_extraction", { corroborationKey: "" })).toBeNull();
  });
});
