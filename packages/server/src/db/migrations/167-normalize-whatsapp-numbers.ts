import type { Kysely } from "kysely";

type MigrationDb = {
  users: { id: string; name: string; whatsapp_number: string | null };
};

/**
 * Normalises `users.whatsapp_number` to E.164.
 *
 * Production held one number in several shapes — `+91 9101299347`,
 * `+91-9667704669`, `+917007413075` — while lookups compared the column
 * exactly. Two rows spelling the same number differently therefore passed the
 * unique constraint and then resolved to the same person's WhatsApp groups.
 *
 * The normalisation is inlined rather than imported from
 * `identity-normalization` because a migration is a historical artifact: it has
 * to keep producing the same result after the application helper changes.
 */
function normalizeE164(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/gu, "");
  const withPlus = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9]\d{7,14}$/u.test(withPlus) ? withPlus : null;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const typed = db as Kysely<MigrationDb>;

  const rows = await typed
    .selectFrom("users")
    .select(["id", "whatsapp_number"])
    .where("whatsapp_number", "is not", null)
    .execute();

  /**
   * Group by canonical form before touching anything.
   *
   * Rewriting row-by-row would let an arbitrary row win the canonical spelling
   * whenever two different spellings normalise to the same free value — the
   * winner decided by whatever order the select returned. Both rows would still
   * resolve to the same access principal afterwards, so uniqueness and access
   * would go on disagreeing, just less visibly.
   */
  const groups = new Map<string, { id: string; stored: string }[]>();
  for (const row of rows) {
    if (row.whatsapp_number === null) continue;
    const normalized = normalizeE164(row.whatsapp_number);
    if (normalized === null) continue;
    const group = groups.get(normalized) ?? [];
    group.push({ id: row.id, stored: row.whatsapp_number });
    groups.set(normalized, group);
  }

  const contested: string[] = [];

  for (const [normalized, members] of groups) {
    /**
     * More than one row means two records claim one number. Which of them is the
     * real owner is a judgement about people, not spellings — a duplicate entry
     * and a recycled number look identical here, and merging the second case
     * would hand one person another's access. Leave every member untouched and
     * report the group instead.
     */
    if (members.length > 1) {
      contested.push(normalized);
      continue;
    }

    const [member] = members;
    if (member === undefined || member.stored === normalized) continue;

    await typed.updateTable("users").set({ whatsapp_number: normalized }).where("id", "=", member.id).execute();
  }

  if (contested.length > 0) {
    console.warn(
      `[167-normalize-whatsapp-numbers] left ${contested.length} number(s) un-normalised because more than one user row claims them; these need manual reconciliation`,
    );
  }
}

export async function down(): Promise<void> {
  /** Not reversible — the original spellings are not recorded anywhere. */
}
