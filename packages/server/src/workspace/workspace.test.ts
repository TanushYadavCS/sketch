/**
 * Tests for workspace file operations API
 * Covers all endpoints and security edge cases
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb } from "../test-utils";

const config = createTestConfig();

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();
  await settings.create();
  await users.create({
    name: normalizedEmail.split("@")[0],
    email: normalizedEmail,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function loginAdmin(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function createMember(db: Kysely<DB>) {
  const users = createUserRepository(db);
  const user = await users.create({ name: "Test Member" });
  await users.update(user.id, { email: `member-${randomUUID()}@test.com` });
  return user;
}

async function getMemberCookie(db: Kysely<DB>, userId: string): Promise<string> {
  const settings = createSettingsRepository(db);
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found in test DB");

  const { signJwt } = await import("../auth/jwt");
  const token = await signJwt(userId, "member", row.jwt_secret);
  return `sketch_session=${token}`;
}

describe("Workspace API", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // Already destroyed
    }
  });

  // --- Path Traversal Security ---

  describe("Security - Path Traversal", () => {
    it("blocks path traversal attack (../../../etc/passwd)", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/files/content?path=../../../etc/passwd", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_PATH");
    });

    it("blocks absolute paths", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/files/content?path=/etc/passwd", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_PATH");
    });

    it("prevents symlink escape attacks", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      // Create a symlink pointing outside the workspace
      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      const { symlink } = await import("node:fs/promises");
      await symlink("/etc/passwd", join(workspaceDir, "evil-link"));

      const res = await app.request("/api/workspace/files/content?path=evil-link", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_PATH");
    });
  });

  // --- List Directory ---

  describe("GET /api/workspace/files", () => {
    it("returns empty array for empty directory", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/files", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files).toEqual([]);
    });

    it("returns files with correct metadata", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      // Create test files
      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "test.txt"), "Hello world");
      await mkdir(join(workspaceDir, "subdir"), { recursive: true });

      const res = await app.request("/api/workspace/files", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files).toHaveLength(2);

      // Check file metadata
      const textFile = body.files.find((f: { name: string }) => f.name === "test.txt");
      expect(textFile).toBeDefined();
      expect(textFile.isDirectory).toBe(false);
      expect(textFile.size).toBe(11);
      expect(textFile.isEditable).toBe(true);
      expect(textFile.mimeType).toBe("text/plain");

      // Check folder metadata
      const folder = body.files.find((f: { name: string }) => f.name === "subdir");
      expect(folder).toBeDefined();
      expect(folder.isDirectory).toBe(true);
    });

    it("sorts directories first then alphabetically", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "zebra.txt"), "z");
      await mkdir(join(workspaceDir, "alpha"), { recursive: true });
      await writeFile(join(workspaceDir, "beta.txt"), "b");

      const res = await app.request("/api/workspace/files", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files.map((f: { name: string }) => f.name)).toEqual(["alpha", "beta.txt", "zebra.txt"]);
    });
  });

  // --- Read File ---

  describe("GET /api/workspace/files/content", () => {
    it("returns text file content with isText=true", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "config.json"), '{"key": "value"}');

      const res = await app.request("/api/workspace/files/content?path=config.json", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toBe('{"key": "value"}');
      expect(body.isText).toBe(true);
      expect(body.mimeType).toBe("application/json");
    });

    it("returns 404 for non-existent file", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/files/content?path=nonexistent.txt", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 400 for trying to read directory as file", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(join(workspaceDir, "mydir"), { recursive: true });

      const res = await app.request("/api/workspace/files/content?path=mydir", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("IS_DIRECTORY");
    });

    it("returns binary files with Content-Disposition attachment", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      // Write a binary file (PNG magic bytes)
      await writeFile(join(workspaceDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const res = await app.request("/api/workspace/files/content?path=image.png", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
    });
  });

  // --- Write File ---

  describe("PUT /api/workspace/files/content", () => {
    it("saves text file content", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "test.txt"), "original");

      const res = await app.request("/api/workspace/files/content?path=test.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ content: "updated content" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify content was written
      const { readFile } = await import("node:fs/promises");
      const saved = await readFile(join(workspaceDir, "test.txt"), "utf-8");
      expect(saved).toBe("updated content");
    });

    it("creates new file if it doesn't exist", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/files/content?path=newfile.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ content: "new content" }),
      });

      expect(res.status).toBe(200);

      // Verify file was created
      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      const { readFile } = await import("node:fs/promises");
      const saved = await readFile(join(workspaceDir, "newfile.txt"), "utf-8");
      expect(saved).toBe("new content");
    });

    it("returns 415 for trying to edit binary file", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      // Create a binary file
      await writeFile(join(workspaceDir, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

      const res = await app.request("/api/workspace/files/content?path=binary.dat", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ content: "text content" }),
      });

      expect(res.status).toBe(415);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_TEXT_FILE");
    });

    it("returns 413 for files larger than 1MB", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      // Create a text file larger than 1MB
      await writeFile(join(workspaceDir, "huge.txt"), "a".repeat(1024 * 1024 + 1));

      const res = await app.request("/api/workspace/files/content?path=huge.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ content: "new content" }),
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("FILE_TOO_LARGE");
    });
  });

  // --- Upload File ---

  describe("POST /api/workspace/files", () => {
    it("uploads file successfully", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const formData = new FormData();
      formData.append("file", new Blob(["uploaded content"], { type: "text/plain" }), "upload.txt");

      const res = await app.request("/api/workspace/files?path=upload.txt", {
        method: "POST",
        headers: { Cookie: cookie },
        body: formData,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify file was uploaded
      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      const { readFile } = await import("node:fs/promises");
      const saved = await readFile(join(workspaceDir, "upload.txt"), "utf-8");
      expect(saved).toBe("uploaded content");
    });

    it("returns 413 for files exceeding size limit", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      // 52MB exceeds the 50MB app-level limit (FILE_TOO_LARGE) while staying
      // under the coarser streaming body-limit ceiling, so the per-route check runs.
      const largeContent = new Uint8Array(52 * 1024 * 1024);
      const formData = new FormData();
      formData.append("file", new Blob([largeContent], { type: "application/octet-stream" }), "large.bin");

      const res = await app.request("/api/workspace/files?path=large.bin", {
        method: "POST",
        headers: { Cookie: cookie },
        body: formData,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("FILE_TOO_LARGE");
    });

    it("rejects bodies over the streaming limit with a 413 envelope before buffering", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      // 70MB exceeds the streaming body-limit ceiling (~55MB for a 50MB config),
      // so it is rejected while streaming, before the handler buffers it.
      const oversized = new Uint8Array(70 * 1024 * 1024);
      const formData = new FormData();
      formData.append("file", new Blob([oversized], { type: "application/octet-stream" }), "oversized.bin");

      const res = await app.request("/api/workspace/files?path=oversized.bin", {
        method: "POST",
        headers: { Cookie: cookie },
        body: formData,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  // --- Create Folder ---

  describe("POST /api/workspace/folders", () => {
    it("creates new folder", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ path: "newfolder" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify folder was created
      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      const { stat } = await import("node:fs/promises");
      const stats = await stat(join(workspaceDir, "newfolder"));
      expect(stats.isDirectory()).toBe(true);
    });

    it("creates nested folders", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ path: "parent/child/grandchild" }),
      });

      expect(res.status).toBe(201);

      // Verify all folders were created
      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      const { stat } = await import("node:fs/promises");
      const stats = await stat(join(workspaceDir, "parent", "child", "grandchild"));
      expect(stats.isDirectory()).toBe(true);
    });

    it("returns 409 if folder already exists", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(join(workspaceDir, "existing"), { recursive: true });

      const res = await app.request("/api/workspace/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ path: "existing" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("ALREADY_EXISTS");
    });
  });

  // --- Rename File ---

  describe("PATCH /api/workspace/files/rename", () => {
    it("renames file successfully", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "oldname.txt"), "content");

      const res = await app.request("/api/workspace/files/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ oldPath: "oldname.txt", newPath: "newname.txt" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify rename worked
      const { access } = await import("node:fs/promises");
      await expect(access(join(workspaceDir, "newname.txt"))).resolves.toBeUndefined();
      await expect(access(join(workspaceDir, "oldname.txt"))).rejects.toThrow();
    });

    it("returns 409 if destination already exists", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "file1.txt"), "content1");
      await writeFile(join(workspaceDir, "file2.txt"), "content2");

      const res = await app.request("/api/workspace/files/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ oldPath: "file1.txt", newPath: "file2.txt" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("ALREADY_EXISTS");
    });
  });

  // --- Delete File ---

  describe("DELETE /api/workspace/files", () => {
    it("deletes file successfully", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "delete-me.txt"), "content");

      const res = await app.request("/api/workspace/files?path=delete-me.txt", {
        method: "DELETE",
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify file was deleted
      const { access } = await import("node:fs/promises");
      await expect(access(join(workspaceDir, "delete-me.txt"))).rejects.toThrow();
    });

    it("returns 404 for non-existent file", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/files?path=nonexistent.txt", {
        method: "DELETE",
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("deletes folder recursively", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const workspaceDir = join(config.DATA_DIR, "workspaces", user.id);
      await mkdir(join(workspaceDir, "folder", "nested"), { recursive: true });
      await writeFile(join(workspaceDir, "folder", "file.txt"), "content");
      await writeFile(join(workspaceDir, "folder", "nested", "inner.txt"), "inner");

      const res = await app.request("/api/workspace/files?path=folder", {
        method: "DELETE",
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);

      // Verify entire folder was deleted
      const { access } = await import("node:fs/promises");
      await expect(access(join(workspaceDir, "folder"))).rejects.toThrow();
    });

    it("prevents deletion of workspace root", async () => {
      await seedAdmin(db);
      const user = await createMember(db);
      const app = createApp(db, config);
      const cookie = await getMemberCookie(db, user.id);

      const res = await app.request("/api/workspace/files?path=.", {
        method: "DELETE",
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("CANNOT_DELETE_ROOT");
    });
  });

  // --- Workspace Isolation ---

  describe("Workspace Isolation", () => {
    it("users cannot access other users' workspaces", async () => {
      await seedAdmin(db);
      const user1 = await createMember(db);
      const user2 = await createMember(db);
      const app = createApp(db, config);

      // User1 creates a file
      const workspaceDir1 = join(config.DATA_DIR, "workspaces", user1.id);
      await mkdir(workspaceDir1, { recursive: true });
      await writeFile(join(workspaceDir1, "secret.txt"), "user1 secret");

      // User2 tries to access user1's file via path traversal (even if they knew the ID)
      // This should be blocked by path validation
      const cookie2 = await getMemberCookie(db, user2.id);

      const res = await app.request("/api/workspace/files/content?path=../${user1.id}/secret.txt", {
        headers: { Cookie: cookie2 },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_PATH");
    });
  });
});
