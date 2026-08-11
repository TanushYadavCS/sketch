import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const connectorsDir = dirname(fileURLToPath(import.meta.url));
const entitiesDir = join(connectorsDir, "../entities");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function materializeCalls(contents: string): string[] {
  return [...contents.matchAll(/await materializeUnmaterializedFacts\([\s\S]*?\}\);/g)].map((match) => match[0]);
}

describe("routine materialization call scopes", () => {
  it("keeps document tasks scoped and narrows both enrichment floor sites to llm_relation", () => {
    const calls = materializeCalls(source(join(connectorsDir, "enrichment.ts")));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('factTypes: ["llm_relation"]');
    expect(calls[1]).toContain('factTypes: ["llm_relation"]');
  });

  it("scopes smart enrichment to its two emitted fact families", () => {
    const calls = materializeCalls(source(join(connectorsDir, "smart-enrichment.ts")));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('factTypes: ["llm_extracted", "llm_relation"]');
  });

  it("scopes domain floor retry and re-enrich post-floor materialization to llm_relation", () => {
    const floorCalls = materializeCalls(source(join(connectorsDir, "engagement-floor.ts")));
    const reenrichCalls = materializeCalls(source(join(entitiesDir, "reenrich.ts")));
    expect(floorCalls).toHaveLength(1);
    expect(floorCalls[0]).toContain('factTypes: ["llm_relation"]');
    expect(reenrichCalls).toHaveLength(1);
    expect(reenrichCalls[0]).toContain('factTypes: ["llm_relation"]');
  });

  it("leaves recreate caller-scoped and keeps manual and OAuth sync entry points inline", () => {
    const recreateCalls = materializeCalls(source(join(entitiesDir, "recreate.ts")));
    const connectorApi = source(join(connectorsDir, "../api/connectors.ts"));
    const oauthApi = source(join(connectorsDir, "../api/oauth.ts"));
    const syncRunner = source(join(connectorsDir, "sync.ts"));

    expect(recreateCalls).toHaveLength(1);
    expect(recreateCalls[0]).toContain("factTypes: deps.materializeFactTypes");
    expect(connectorApi).toContain("runConnectorSync(db, connectorId, logger, config, {");
    expect(oauthApi.match(/runConnectorSync\(db, connectorConfig\.id, logger, appConfig\)/g)).toHaveLength(3);
    expect(syncRunner).toContain('postSyncMode: "deferred"');
  });
});
