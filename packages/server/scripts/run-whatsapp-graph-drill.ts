/**
 * Drill-tool manual-verification driver (runbook cases G1-G5 + F3). Invokes the
 * REAL WhatsAppGroupHistory handler against the seeded scratch DB as three
 * viewers: a group member (Alice), a second member (Bob), and a non-member
 * (Carol, created here). Prints each case's outcome plus a privacy sweep over
 * every rendered payload.
 *
 *   SQLITE_PATH=./data/manual-verify.db pnpm exec tsx scripts/run-whatsapp-graph-drill.ts
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { handleSearch } from "../src/agent/tools/search";
import { handleWhatsAppGroupHistory } from "../src/agent/tools/whatsapp-group-history";
import type { SketchMcpDeps } from "../src/agent/tools/types";
import { UploadCollector } from "../src/agent/sketch-tools";
import { loadConfig, validateConfig } from "../src/config";
import { createDatabase } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import { createUserRepository } from "../src/db/repositories/users";
import type { DB } from "../src/db/schema";

const rawIdentifier = /(\+?[1-9]\d{9,14}\b)|([^\s"'<>()[\]{}]+@(?:s\.whatsapp\.net|lid)\b)/u;

function deps(db: Kysely<DB>, currentUserId: string): SketchMcpDeps {
  return {
    db,
    userRepo: createUserRepository(db),
    currentUserId,
    uploadCollector: new UploadCollector(),
    workspaceDir: "/tmp/workspace",
  };
}

function firstText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

function report(label: string, text: string, expectation: string): void {
  const leak = rawIdentifier.exec(text);
  console.log(`\n=== ${label} ===`);
  console.log(`expectation: ${expectation}`);
  console.log(`privacy: ${leak ? `LEAK: ${leak[0]}` : "clean"}`);
  console.log(text.length > 1600 ? `${text.slice(0, 1600)}\n…[truncated ${text.length} chars total]` : text);
}

async function main() {
  const config = loadConfig();
  validateConfig(config);
  const db = await createDatabase(config);

  try {
    await runMigrations(db, { quiet: true });

    const alice = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("email", "=", "alice@canvasx-test.ai")
      .executeTakeFirstOrThrow();
    let carol = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("email", "=", "carol@canvasx-test.ai")
      .executeTakeFirst();
    if (!carol) {
      const id = randomUUID();
      await db
        .insertInto("users")
        .values({ id, name: "Carol NonMember", email: "carol@canvasx-test.ai" })
        .execute();
      carol = { id, email: "carol@canvasx-test.ai" };
    }

    const busyKeptSlice = await db
      .selectFrom("conversation_slices")
      .select(["id", "conversation_id", "started_at", "ended_at"])
      .where("conversation_id", "=", 1)
      .where("salience_verdict", "=", "kept")
      .orderBy("started_at", "asc")
      .executeTakeFirstOrThrow();
    const externalOnlyKeptSlice = await db
      .selectFrom("conversation_slices")
      .select(["id"])
      .where("conversation_id", "=", 4)
      .executeTakeFirstOrThrow();

    /** G2: member drills a kept slice; expand pulls the adjacent DROPPED banter session. */
    const g2 = await handleWhatsAppGroupHistory(
      { sliceId: busyKeptSlice.id, expandMinutes: 120, limit: 200 },
      deps(db, alice.id),
    );
    const g2Text = firstText(g2);
    report("G2 member drills kept slice, expand=120min", g2Text, "raw window incl. dropped banter msgs (haha/banter)");

    /** G3: window expansion via groupRef+startedAt/endedAt from the prior result. */
    const g2Payload = JSON.parse(g2Text) as { groupRef: string; window: { start: string; end: string } };
    const g3 = await handleWhatsAppGroupHistory(
      {
        groupRef: g2Payload.groupRef,
        startedAt: g2Payload.window.start,
        endedAt: g2Payload.window.end,
        expandMinutes: 60,
        limit: 200,
      },
      deps(db, alice.id),
    );
    report("G3 window drill via groupRef from prior result", firstText(g3), "authorized window, adjacent msgs");

    /** G4a: non-member drills the same slice -> uniform denial. */
    const g4a = await handleWhatsAppGroupHistory({ sliceId: busyKeptSlice.id }, deps(db, carol.id));
    report("G4a non-member drills member slice", firstText(g4a), "uniform denial text");

    /** G4b: member drills the external-only group's kept-but-unindexed slice -> denial (fail-closed). */
    const g4b = await handleWhatsAppGroupHistory({ sliceId: externalOnlyKeptSlice.id }, deps(db, alice.id));
    report("G4b kept-but-unindexed slice (zero-teammate group)", firstText(g4b), "uniform denial text");

    /** G4c: probe a non-opted-in group by synthesized groupRef -> denial. */
    const g4c = await handleWhatsAppGroupHistory(
      {
        groupRef: "conversation:3",
        startedAt: busyKeptSlice.started_at,
        endedAt: busyKeptSlice.ended_at,
      },
      deps(db, alice.id),
    );
    report("G4c synthesized groupRef for disabled group", firstText(g4c), "uniform denial text");

    /** Pagination: limit=2 -> nextPageToken -> next page continues, bound to same window. */
    const page1 = await handleWhatsAppGroupHistory(
      { sliceId: busyKeptSlice.id, expandMinutes: 120, limit: 2 },
      deps(db, alice.id),
    );
    const page1Payload = JSON.parse(firstText(page1)) as { nextPageToken?: string; messages: unknown[] };
    console.log(`\n=== pagination page1: ${page1Payload.messages.length} msgs, hasToken=${Boolean(page1Payload.nextPageToken)} ===`);
    if (page1Payload.nextPageToken) {
      const page2 = await handleWhatsAppGroupHistory(
        { sliceId: busyKeptSlice.id, expandMinutes: 120, limit: 2, pageToken: page1Payload.nextPageToken },
        deps(db, alice.id),
      );
      report("pagination page2 via pageToken", firstText(page2), "next 2 msgs, no overlap with page1");
    }

    /** G1/F3: the REAL Search tool — Alice gets WhatsApp hits, non-member Carol gets none. */
    for (const viewer of [alice, carol]) {
      const search = await handleSearch(
        { query: "Acme proposal", source: "whatsapp", limit: 10 },
        deps(db, viewer.id),
      );
      report(`G1/F3 Search as ${viewer.email}`, firstText(search), "member: whatsapp hits; non-member: none");
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
