import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import { getPostSyncCoordinator } from "./post-sync-coordinator";
import { connectorFactories } from "./registry";
import type { Connector, SyncedItem } from "./types";

const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";
const CONNECTOR_ID = "gmail-graph-passes";
const originalGmailFactory = connectorFactories.gmail;

const MEETING_BODY = `# OW <> Canvas Standup
## Action Items
-
**Vedant Parikh**
Continue Aviation Edge scraper (05:00)

**Ohoud Zitan**
Provide updated purpose of travel data (06:16)
`;

interface Harness {
  db: Kysely<DB>;
  app: ReturnType<typeof createApp>;
  cookie: string;
  ownerId: string;
}

function testGmailConnector(items: SyncedItem[], afterSync?: () => Promise<void>): Connector {
  return {
    type: "gmail",
    perUserAuth: true,
    requiresOAuthClientSetup: false,
    syncIsCompleteSnapshot: true,
    emitsCorrespondentFacts: true,
    async validateCredentials() {},
    async *sync() {
      for (const item of items) yield item;
      await afterSync?.();
    },
    async getCursor() {
      return null;
    },
  };
}

function emailItem(id: string): SyncedItem {
  return {
    providerFileId: id,
    providerUrl: null,
    fileName: `${id}.eml`,
    fileType: "email",
    contentCategory: "document",
    content: `Message with Person ${id}`,
    sourcePath: null,
    contentHash: `hash-${id}`,
    sourceCreatedAt: "2026-08-11T00:00:00.000Z",
    sourceUpdatedAt: "2026-08-11T00:00:00.000Z",
    attendees: [{ name: `Person ${id}`, email: `person-${id}@example-${id}.com` }],
  };
}

async function seedAdmin(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
    skipEntityLinking: true,
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const admin = await users.findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");
  return admin.id;
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie") ?? "";
}

async function seedConnector(db: Kysely<DB>, ownerId: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "gmail",
      auth_type: "system",
      credentials: JSON.stringify({ type: "system" }),
      created_by: ownerId,
      scope_config: "{}",
      sync_status: "active",
    })
    .execute();
}

async function createHarness(): Promise<Harness> {
  const db = await createTestPgDb();
  const ownerId = await seedAdmin(db);
  await seedConnector(db, ownerId);
  const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger: createTestLogger() });
  return { db, app, cookie: await login(app), ownerId };
}

async function listGraphRuns(app: ReturnType<typeof createApp>, cookie: string) {
  const res = await app.request("/api/graph-passes/runs", { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    runs: Array<{
      id: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      errorMessage: string | null;
    }>;
  };
}

async function triggerSync(app: ReturnType<typeof createApp>, cookie: string): Promise<void> {
  const start = await app.request(`/api/connectors/${CONNECTOR_ID}/syncs`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  expect(start.status).toBe(201);
}

async function waitForConnectorStatus(
  app: ReturnType<typeof createApp>,
  cookie: string,
  status: "active" | "error",
): Promise<string> {
  let observedAt = "";
  await vi.waitFor(
    async () => {
      const res = await app.request(`/api/connectors/${CONNECTOR_ID}`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connector: { syncStatus: string } };
      expect(body.connector.syncStatus).toBe(status);
      observedAt = new Date().toISOString();
    },
    { timeout: 20_000, interval: 25 },
  );
  return observedAt;
}

async function waitForRunStatus(app: ReturnType<typeof createApp>, cookie: string, status: string) {
  let runId = "";
  await vi.waitFor(
    async () => {
      const { runs } = await listGraphRuns(app, cookie);
      const run = runs.find((candidate) => candidate.status === status);
      expect(run).toBeDefined();
      runId = run?.id ?? "";
    },
    { timeout: 20_000, interval: 25 },
  );
  const res = await app.request(`/api/graph-passes/runs/${runId}`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    run: { id: string; status: string; finishedAt: string | null; errorMessage: string | null };
  };
}

async function waitForAnyRun(app: ReturnType<typeof createApp>, cookie: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const { runs } = await listGraphRuns(app, cookie);
      expect(runs.length).toBeGreaterThan(0);
    },
    { timeout: 20_000, interval: 25 },
  );
}

async function seedFile(
  db: Kysely<DB>,
  input: { id: string; connectorId: string; ownerId: string; source: string; content: string },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: input.id,
      connector_config_id: input.connectorId,
      provider_file_id: input.id,
      file_name: input.id,
      file_type: "meeting",
      content_category: "meeting",
      content: input.content,
      source: input.source,
      content_hash: `hash-${input.id}`,
      synced_at: new Date().toISOString(),
    })
    .execute();

  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.id,
    connectorConfigId: input.connectorId,
    createdByUserId: input.ownerId,
    contentHash: `hash-${input.id}`,
    source: input.source,
    factType: "attendee",
    relation: "attended",
    subjectName: "Vedant Parikh",
    subjectEmail: input.id === "promoted-file" ? "vedant@canvasx.ai" : "vedant@quietco.com",
    subjectSource: input.source,
    subjectSourceId: `${input.id}:vedant`,
    raw: {
      providerFileId: input.id,
      fileType: "meeting",
      attendee: {
        name: "Vedant Parikh",
        email: input.id === "promoted-file" ? "vedant@canvasx.ai" : "vedant@quietco.com",
      },
    },
  });
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.id,
    connectorConfigId: input.connectorId,
    createdByUserId: input.ownerId,
    contentHash: `hash-${input.id}`,
    source: input.source,
    factType: "attendee",
    relation: "attended",
    subjectName: "Ohoud Zitan",
    subjectEmail: input.id === "promoted-file" ? "ohoud.zitan@oliverwyman.com" : "ohoud.zitan@partnerco.com",
    subjectSource: input.source,
    subjectSourceId: `${input.id}:ohoud`,
    raw: {
      providerFileId: input.id,
      fileType: "meeting",
      attendee: {
        name: "Ohoud Zitan",
        email: input.id === "promoted-file" ? "ohoud.zitan@oliverwyman.com" : "ohoud.zitan@partnerco.com",
      },
    },
  });
}

async function seedDomainFloorFixture(db: Kysely<DB>, ownerId: string): Promise<void> {
  const entityRepo = createEntityRepository(db);
  const domainsRepo = createEntityDomainsRepository(db);
  const oliverWyman = await entityRepo.upsertEntity({
    name: "Oliver Wyman",
    sourceType: "company",
    status: "confirmed",
  });
  const quietCo = await entityRepo.upsertEntity({ name: "Quiet Co", sourceType: "company", status: "confirmed" });
  const partnerCo = await entityRepo.upsertEntity({ name: "Partner Co", sourceType: "company", status: "confirmed" });
  const vedant = await entityRepo.upsertPersonEntity({
    name: "Vedant Parikh",
    email: "vedant@canvasx.ai",
    subtype: "internal",
    source: "team",
    sourceId: "vedant",
  });
  await domainsRepo.upsertDomain({
    entityId: oliverWyman.id,
    domain: "oliverwyman.com",
    kind: "corporate",
    source: "manual",
    confidence: 1,
    isPrimary: true,
  });
  await domainsRepo.upsertDomain({
    entityId: quietCo.id,
    domain: "quietco.com",
    kind: "corporate",
    source: "manual",
    confidence: 1,
    isPrimary: true,
  });
  await domainsRepo.upsertDomain({
    entityId: partnerCo.id,
    domain: "partnerco.com",
    kind: "corporate",
    source: "manual",
    confidence: 1,
    isPrimary: true,
  });
  await seedFile(db, {
    id: "promoted-file",
    connectorId: CONNECTOR_ID,
    ownerId,
    source: "gmail",
    content: MEETING_BODY,
  });
  await seedFile(db, { id: "quiet-file", connectorId: CONNECTOR_ID, ownerId, source: "gmail", content: MEETING_BODY });
  await domainsRepo.upsertDomainObservation({
    domain: "canvasx.ai",
    proposedCompanyName: "Canvas",
    observedPersonEntityId: vedant.id,
    evidenceFileId: "promoted-file",
    firstObservedByUserId: ownerId,
  });
}

describe("graph pass runs over HTTP", () => {
  afterEach(() => {
    connectorFactories.gmail = originalGmailFactory;
  });

  it("completes a manual sync drain before the connector reports active", async () => {
    const harness = await createHarness();
    try {
      connectorFactories.gmail = () => testGmailConnector(Array.from({ length: 50 }, (_, i) => emailItem(String(i))));

      await triggerSync(harness.app, harness.cookie);
      await waitForAnyRun(harness.app, harness.cookie);
      const activeObservedAt = await waitForConnectorStatus(harness.app, harness.cookie, "active");
      const { runs } = await listGraphRuns(harness.app, harness.cookie);
      const completeRuns = runs.filter((run) => run.status === "complete");

      expect(completeRuns).toHaveLength(1);
      const finishedAt = completeRuns[0].finishedAt;
      expect(finishedAt).not.toBeNull();
      if (!finishedAt) throw new Error("missing finishedAt");
      expect(finishedAt <= activeObservedAt).toBe(true);
    } finally {
      await harness.db.destroy();
    }
  });

  it("restores an unfinished drain and a further trigger is a no-op", async () => {
    const harness = await createHarness();
    try {
      const snapshot = { affectedIndexedFileIds: [], sources: ["gmail"], workCycleReconciles: [] };
      await harness.db
        .insertInto("graph_pass_runs")
        .values({
          id: "interrupted-drain",
          status: "running",
          started_at: "2026-08-11T00:00:00.000Z",
          input_snapshot_json: JSON.stringify(snapshot),
        })
        .execute();

      await getPostSyncCoordinator(harness.db).restoreUnfinished({
        db: harness.db,
        logger: createTestLogger(),
      });

      const restored = await harness.app.request("/api/graph-passes/runs/interrupted-drain", {
        headers: { Cookie: harness.cookie },
      });
      expect(restored.status).toBe(200);
      const body = (await restored.json()) as { run: { status: string; finishedAt: string | null } };
      expect(body.run.status).toBe("complete");
      expect(body.run.finishedAt).not.toBeNull();

      const trigger = await harness.app.request("/api/graph-passes/runs", {
        method: "POST",
        headers: { Cookie: harness.cookie },
      });
      expect(trigger.status).toBe(201);
      const triggerBody = (await trigger.json()) as { run: unknown; joined: boolean; status: string };
      expect(triggerBody).toEqual({ run: null, joined: false, status: "queued" });
      const { runs } = await listGraphRuns(harness.app, harness.cookie);
      expect(runs).toHaveLength(1);
    } finally {
      await harness.db.destroy();
    }
  });

  it("reports failed drains and preserves the domain-promotion to floor-retry hand-off", async () => {
    const handoff = await createHarness();
    try {
      await seedDomainFloorFixture(handoff.db, handoff.ownerId);
      connectorFactories.gmail = () => testGmailConnector([]);

      await triggerSync(handoff.app, handoff.cookie);
      await waitForAnyRun(handoff.app, handoff.cookie);
      const complete = await waitForRunStatus(handoff.app, handoff.cookie, "complete");
      await waitForConnectorStatus(handoff.app, handoff.cookie, "active");
      expect(complete.run.finishedAt).not.toBeNull();

      const promotedDomain = await handoff.db
        .selectFrom("entity_domains")
        .select("domain")
        .where("domain", "=", "canvasx.ai")
        .where("entity_id", "is not", null)
        .execute();
      const promotedFloorFacts = await handoff.db
        .selectFrom("indexed_file_facts")
        .select("id")
        .where("source", "=", "attendee_action_item")
        .where("indexed_file_id", "=", "promoted-file")
        .where("deleted_at", "is", null)
        .execute();
      const unpromotedFloorFacts = await handoff.db
        .selectFrom("indexed_file_facts")
        .select("id")
        .where("source", "=", "attendee_action_item")
        .where("indexed_file_id", "=", "quiet-file")
        .where("deleted_at", "is", null)
        .execute();
      expect(promotedDomain).toHaveLength(1);
      expect(promotedFloorFacts.length).toBeGreaterThan(0);
      expect(unpromotedFloorFacts).toHaveLength(0);
    } finally {
      await handoff.db.destroy();
    }

    const failing = await createHarness();
    try {
      connectorFactories.gmail = () =>
        testGmailConnector([emailItem("failure")], async () => {
          await failing.db.schema.dropTable("entities").cascade().execute();
        });

      await triggerSync(failing.app, failing.cookie);
      await waitForAnyRun(failing.app, failing.cookie);
      await waitForConnectorStatus(failing.app, failing.cookie, "error");
      const failed = await waitForRunStatus(failing.app, failing.cookie, "failed");
      expect(failed.run.errorMessage).toContain("entities");
    } finally {
      await failing.db.destroy();
    }
  });
});
