import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compactEntityNameKey,
  matchesNameOrAliasExactly,
  normalizeEntityMatchName,
  normalizeName,
  normalizeParticipantNameKey,
} from "./name-keys";

const SRC_ROOT = join(import.meta.dirname, "..");
const SERVER_ROOT = join(SRC_ROOT, "..");
const SELF = "entities/name-keys.test.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("name key normalization", () => {
  it("preserves frozen normalizer outputs", () => {
    expect(normalizeName("  Acme   Corp ")).toBe("acme corp");
    expect(normalizeName("Acme Inc.")).toBe("acme inc");
    expect(normalizeName("Acme,")).toBe("acme");
    expect(normalizeName("acme.io")).toBe("acme.io");

    expect(normalizeEntityMatchName("product", "GPT4")).toBe("gpt 4");
    expect(normalizeEntityMatchName("project", "GPT4")).toBe("gpt4");
    expect(normalizeEntityMatchName("product", "GPT-4_beta")).toBe("gpt 4 beta");

    expect(compactEntityNameKey("company", "One Stop")).toBe("onestop");
    expect(compactEntityNameKey("company", "one-stop")).toBe("onestop");
    expect(compactEntityNameKey("company", "one.stop")).toBe("onestop");
  });

  it("retires the match-normalize alias without changing the exact-alias contract", () => {
    const candidate = { name: "Oliver Wyman", aliases: ["OW"] };
    expect(matchesNameOrAliasExactly("OW", candidate)).toBe(true);
    expect(matchesNameOrAliasExactly("of", candidate)).toBe(false);

    const deletedAlias = ["normalize", "Match", "Name"].join("");
    const deletedModule = ["entities", "match-normalize"].join("/");
    const stalePatterns: Array<{ label: string; re: RegExp }> = [
      { label: "deleted alias", re: new RegExp(String.raw`\b${deletedAlias}\b`) },
      { label: "deleted module", re: new RegExp(deletedModule) },
    ];
    const files = [...sourceFiles(SRC_ROOT), ...sourceFiles(join(SERVER_ROOT, "scripts"))].sort();
    const offenders = files
      .map((file) => {
        const rel = relative(SRC_ROOT, file);
        if (rel === SELF) return { file: rel, hits: [] };
        const src = readFileSync(file, "utf8");
        const hits = stalePatterns.filter((p) => p.re.test(src)).map((p) => p.label);
        return { file: rel, hits };
      })
      .filter((o) => o.hits.length > 0);

    const message = offenders.length
      ? `These files still reference the deleted match normalizer alias/module:\n  ${offenders
          .map((o) => `${o.file} (${o.hits.join(", ")})`)
          .join("\n  ")}`
      : "";
    expect(offenders, message).toEqual([]);
  });

  it("preserves participant name key outputs", () => {
    expect(normalizeParticipantNameKey("Vedant Parikh")).toBe("vedant parikh");
    expect(normalizeParticipantNameKey("Vedant K. Parikh")).toBe("vedant parikh");
    expect(normalizeParticipantNameKey("Vedant k Parikh")).toBe("vedant parikh");
    expect(normalizeParticipantNameKey("A. B.")).toBe("");
    expect(normalizeParticipantNameKey("X. AE Team")).toBe("ae team");
    expect(normalizeParticipantNameKey("  Ohoud   Zitan  ")).toBe("ohoud zitan");
  });
});
