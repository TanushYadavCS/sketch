import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedSlackOrganizationDomain } from "./bootstrap";
import type { DB } from "./db/schema";
import { createTestDb, createTestPgDb } from "./test-utils";

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("seeds every verified admin corporate domain idempotently", async () => {
      await db
        .insertInto("users")
        .values([
          {
            id: "admin-1",
            name: "Personal Admin",
            email: "admin@gmail.com",
            email_verified_at: "2026-08-01T00:00:00.000Z",
            auth_role: "admin",
          },
          {
            id: "admin-2",
            name: "First Corporate Admin",
            email: "first@acme.example",
            email_verified_at: "2026-08-02T00:00:00.000Z",
            auth_role: "admin",
          },
          {
            id: "admin-3",
            name: "Second Corporate Admin",
            email: "second@other.example",
            email_verified_at: "2026-08-03T00:00:00.000Z",
            auth_role: "admin",
          },
        ])
        .execute();

      const logger = { warn: vi.fn() };
      await expect(seedSlackOrganizationDomain(db, logger)).resolves.toBe("acme.example");
      await expect(seedSlackOrganizationDomain(db, logger)).resolves.toBe("acme.example");
      await expect(
        db
          .selectFrom("organization_domains")
          .select("domain")
          .where("source", "=", "admin_email_seed")
          .orderBy("domain", "asc")
          .execute(),
      ).resolves.toEqual([{ domain: "acme.example" }, { domain: "other.example" }]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("warns when no verified admin corporate domain can be seeded", async () => {
      await db
        .insertInto("users")
        .values({
          id: "admin-personal",
          name: "Personal Admin",
          email: "admin@gmail.com",
          email_verified_at: "2026-08-01T00:00:00.000Z",
          auth_role: "admin",
        })
        .execute();
      const logger = { warn: vi.fn() };

      await expect(seedSlackOrganizationDomain(db, logger)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        "No corporate admin email domains could be seeded; classification will be unknown until a domain is configured",
      );
    });
  });
}

runSuite("Slack organization domain seeding SQLite", createTestDb);
runSuite("Slack organization domain seeding Postgres", createTestPgDb);
