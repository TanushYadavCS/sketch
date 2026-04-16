import { describe, expect, it, vi } from "vitest";
import type { ResolveSlackUserDeps } from "./resolve-user";
import { resolveSlackUser } from "./resolve-user";

const makeUser = (
  overrides: Partial<
    ReturnType<ResolveSlackUserDeps["users"]["findBySlackId"]> extends Promise<infer T> ? NonNullable<T> : never
  > = {},
) => ({
  id: "u1",
  name: "Alice",
  email: null as string | null,
  slack_user_id: null as string | null,
  whatsapp_number: null as string | null,
  created_at: "2026-01-01T00:00:00Z",
  email_verified_at: null as string | null,
  tool_progress: null as string | null,
  reasoning_text: null as number | null,
  ...overrides,
});

function makeDeps(overrides: Partial<ResolveSlackUserDeps> = {}): ResolveSlackUserDeps {
  return {
    users: {
      findBySlackId: vi.fn().mockResolvedValue(undefined),
      findByEmail: vi.fn().mockResolvedValue(undefined),
      create: vi
        .fn()
        .mockImplementation(async (data) =>
          makeUser({ name: data.name, slack_user_id: data.slackUserId, email: data.email }),
        ),
      update: vi
        .fn()
        .mockImplementation(async (id, data) =>
          makeUser({ id, slack_user_id: data.slackUserId ?? null, email: data.email ?? null }),
        ),
    },
    getUserInfo: vi.fn().mockResolvedValue({ name: "alice", realName: "Alice", email: "alice@example.com" }),
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ResolveSlackUserDeps["logger"],
    ...overrides,
  };
}

describe("resolveSlackUser", () => {
  it("returns existing user found by Slack ID", async () => {
    const existing = makeUser({ id: "u1", slack_user_id: "U001", email: "alice@example.com" });
    const deps = makeDeps();
    vi.mocked(deps.users.findBySlackId).mockResolvedValue(existing);

    const result = await resolveSlackUser("U001", deps);

    expect(result).toBe(existing);
    expect(deps.getUserInfo).not.toHaveBeenCalled();
    expect(deps.users.create).not.toHaveBeenCalled();
  });

  it("backfills email when existing user has none", async () => {
    const existing = makeUser({ id: "u1", slack_user_id: "U001", email: null });
    const updated = makeUser({ id: "u1", slack_user_id: "U001", email: "alice@example.com" });
    const deps = makeDeps();
    vi.mocked(deps.users.findBySlackId).mockResolvedValue(existing);
    vi.mocked(deps.users.update).mockResolvedValue(updated);

    const result = await resolveSlackUser("U001", deps);

    expect(deps.getUserInfo).toHaveBeenCalledWith("U001");
    expect(deps.users.update).toHaveBeenCalledWith("u1", { email: "alice@example.com", emailVerified: true });
    expect(result).toBe(updated);
  });

  it("does not backfill when Slack profile has no email", async () => {
    const existing = makeUser({ id: "u1", slack_user_id: "U001", email: null });
    const deps = makeDeps();
    vi.mocked(deps.users.findBySlackId).mockResolvedValue(existing);
    vi.mocked(deps.getUserInfo).mockResolvedValue({ name: "alice", realName: "Alice", email: null });

    const result = await resolveSlackUser("U001", deps);

    expect(deps.users.update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it("links Slack ID to existing user found by email", async () => {
    const emailUser = makeUser({ id: "u2", email: "alice@example.com", slack_user_id: null });
    const linked = makeUser({ id: "u2", email: "alice@example.com", slack_user_id: "U001" });
    const deps = makeDeps();
    vi.mocked(deps.users.findByEmail).mockResolvedValue(emailUser);
    vi.mocked(deps.users.update).mockResolvedValue(linked);

    const result = await resolveSlackUser("U001", deps);

    expect(deps.users.findByEmail).toHaveBeenCalledWith("alice@example.com");
    expect(deps.users.update).toHaveBeenCalledWith("u2", { slackUserId: "U001", emailVerified: true });
    expect(deps.users.create).not.toHaveBeenCalled();
    expect(result).toBe(linked);
  });

  it("does not overwrite existing Slack ID when email matches a different Slack user", async () => {
    const otherSlackUser = makeUser({ id: "u3", email: "alice@example.com", slack_user_id: "U999" });
    const created = makeUser({ id: "u-new", slack_user_id: "U001", email: "alice@example.com" });
    const deps = makeDeps();
    vi.mocked(deps.users.findByEmail).mockResolvedValue(otherSlackUser);
    vi.mocked(deps.users.create).mockResolvedValue(created);

    const result = await resolveSlackUser("U001", deps);

    expect(deps.users.update).not.toHaveBeenCalled();
    expect(deps.users.create).toHaveBeenCalled();
    expect(result).toBe(created);
  });

  it("creates new user when no match by Slack ID or email", async () => {
    const created = makeUser({ id: "u-new", name: "Alice", slack_user_id: "U001", email: "alice@example.com" });
    const deps = makeDeps();
    vi.mocked(deps.users.create).mockResolvedValue(created);

    const result = await resolveSlackUser("U001", deps);

    expect(deps.users.create).toHaveBeenCalledWith({
      name: "Alice",
      slackUserId: "U001",
      email: "alice@example.com",
      emailVerified: true,
    });
    expect(result).toBe(created);
  });

  it("creates new user when Slack profile has no email (skips email lookup)", async () => {
    const created = makeUser({ id: "u-new", slack_user_id: "U001", email: null });
    const deps = makeDeps();
    vi.mocked(deps.getUserInfo).mockResolvedValue({ name: "bob", realName: "Bob", email: null });
    vi.mocked(deps.users.create).mockResolvedValue(created);

    const result = await resolveSlackUser("U001", deps);

    expect(deps.users.findByEmail).not.toHaveBeenCalled();
    expect(deps.users.create).toHaveBeenCalledWith({
      name: "Bob",
      slackUserId: "U001",
      email: null,
      emailVerified: false,
    });
    expect(result).toBe(created);
  });
});
