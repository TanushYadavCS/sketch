import { describe, expect, it } from "vitest";
import { type CompanyRelationshipDeclarationRow, resolveDeclaration } from "./company-relationship-declarations";

function row(subject: string, kind: string, stage: string | null = null): CompanyRelationshipDeclarationRow {
  return {
    subject_entity_id: subject,
    counterparty_kind: kind,
    client_stage: stage,
    note: null,
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:00:00.000Z",
  };
}

describe("resolveDeclaration", () => {
  it("returns null when no shard carries a usable declaration", () => {
    expect(resolveDeclaration([])).toBeNull();
    expect(resolveDeclaration([row("a", "not-a-kind")])).toBeNull();
  });

  /**
   * Shards arrive in group order, which is alphabetical by company name — so a
   * test that fed them already-ranked would assert nothing. Each case puts the
   * winner last.
   */
  it("prefers client over every other kind regardless of input order", () => {
    const chosen = resolveDeclaration([row("a", "other"), row("b", "vendor"), row("c", "client", "active")]);
    expect(chosen?.subject_entity_id).toBe("c");
  });

  /**
   * The kind that mints wins. Ordering partner below vendor resolves this pair
   * to silence and suppresses real partner work — mutate KIND_PRECEDENCE to put
   * partner after vendor and only this expectation should break.
   */
  it("prefers partner over the no-write kinds", () => {
    expect(resolveDeclaration([row("a", "vendor"), row("b", "partner", "active")])?.subject_entity_id).toBe("b");
    expect(resolveDeclaration([row("a", "investor"), row("b", "partner", "pilot")])?.subject_entity_id).toBe("b");
    expect(resolveDeclaration([row("a", "other"), row("b", "partner", "ended")])?.subject_entity_id).toBe("b");
  });

  it("still resolves when only no-write kinds disagree", () => {
    expect(resolveDeclaration([row("a", "other"), row("b", "vendor")])?.subject_entity_id).toBe("b");
  });

  it("ignores unrecognised kinds rather than letting them win", () => {
    const chosen = resolveDeclaration([row("a", "prospect"), row("b", "investor")]);
    expect(chosen?.subject_entity_id).toBe("b");
  });
});
