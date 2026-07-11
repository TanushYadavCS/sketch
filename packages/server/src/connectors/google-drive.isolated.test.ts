/**
 * Tests for the Google Drive connector.
 *
 * Security: folderId injection guard
 * Quality: resolveFolderPath max depth, fileToSyncedItem mimeType field
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fetchFileContent, fileToSyncedItem, listFolderContents, resolveFolderPath } from "./google-drive";

/** Minimal logger stub — fetchFileContent only calls debug/warn/info. */
const testLogger = { debug: () => {}, warn: () => {}, info: () => {} } as unknown as Logger;

// Prevent any real HTTP calls. If validation is missing, the fetch mock will be
// called with the injected query string — which itself is the failure signal.
vi.mock("node:https", () => ({}));

// Intercept fetch at the global level. A well-implemented fix should throw
// BEFORE reaching fetch.
const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));

// Restore fetch after all tests in this file so the spy doesn't leak into
// other test files running in the same worker pool.
afterAll(() => {
  fetchSpy.mockRestore();
});

describe("listFolderContents — folderId injection guard", () => {
  it("rejects a folderId containing a single quote", async () => {
    await expect(listFolderContents("access-token", "abc'def")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a folderId containing a backtick", async () => {
    await expect(listFolderContents("access-token", "abc`def")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a folderId containing a double quote", async () => {
    await expect(listFolderContents("access-token", 'abc"def')).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a folderId with spaces", async () => {
    await expect(listFolderContents("access-token", "abc def")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a folderId with a path traversal attempt", async () => {
    await expect(listFolderContents("access-token", "../secret")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a well-formed folderId (alphanumeric with hyphens and underscores)", async () => {
    // A valid Drive folder ID looks like "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs" —
    // alphanumeric and safe. The test only checks that the function does NOT
    // reject the input (it may still throw because fetch is mocked, but the
    // throw must come from the network mock, not validation).
    //
    // We reset the spy to track the call, then confirm fetch was actually
    // attempted (meaning validation passed).
    //
    // driveRequest retries network failures with exponential backoff (1s + 2s).
    // Fake timers drive those retries to completion instantly instead of waiting
    // ~3s of real time, while still executing every retry/backoff branch.
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValue(new Error("network mock"));

    vi.useFakeTimers();
    try {
      const assertion = expect(listFolderContents("access-token", "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs")).rejects.toThrow(
        "network mock",
      );
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    // fetch was called — validation did not block the well-formed ID
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("fileToSyncedItem — mimeType field", () => {
  it("includes mimeType in the returned SyncedItem", () => {
    const file = {
      id: "file-abc",
      name: "report.pdf",
      mimeType: "application/pdf",
      webViewLink: "https://drive.google.com/file/d/file-abc",
      createdTime: "2025-01-01T00:00:00Z",
      modifiedTime: "2025-03-01T00:00:00Z",
    };

    const item = fileToSyncedItem(file, "some content", "hash123", "My Drive / Reports", {});
    expect(item.mimeType).toBe("application/pdf");
  });

  it("preserves mimeType for Google Docs native format", () => {
    const file = {
      id: "doc-xyz",
      name: "My Doc",
      mimeType: "application/vnd.google-apps.document",
      webViewLink: "https://docs.google.com/document/d/doc-xyz",
    };

    const item = fileToSyncedItem(file, "exported text", null, null, {});
    expect(item.mimeType).toBe("application/vnd.google-apps.document");
  });
});

describe("fileToSyncedItem — author fields", () => {
  it("maps the first owner with an email to author metadata", () => {
    const file = {
      id: "doc-owner",
      name: "Owned Doc",
      mimeType: "application/vnd.google-apps.document",
      owners: [
        { displayName: "No Email" },
        { displayName: "Ada Lovelace", emailAddress: "ada@example.com", permissionId: "perm-ada" },
      ],
    };

    const item = fileToSyncedItem(file, "content", "hash", "My Drive", {});
    expect(item.authorEmail).toBe("ada@example.com");
    expect(item.authorName).toBe("Ada Lovelace");
    expect(item.authorSourceId).toBe("perm-ada");
  });
});

describe("resolveFolderPath — max depth guard", () => {
  it("stops traversal at 20 levels and returns a partial path", async () => {
    // Build a chain of 25 folder IDs each pointing to the next parent.
    // Without the depth guard, this would loop indefinitely (if the chain had no root).
    const folderIds = Array.from({ length: 25 }, (_, i) => `folder-${i}`);
    const folderCache = new Map<string, string>();

    // Mock fetch: each folder returns its parent (next in the chain).
    // The last folder (folderIds[24]) has no parents, so the chain is actually finite
    // but longer than the max depth of 20.
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      // Extract the folder ID from the URL (e.g. /files/folder-3?...)
      const match = urlStr.match(/\/files\/(folder-\d+)/);
      if (!match) throw new Error("unexpected URL");
      const folderId = match[1];
      const idx = folderIds.indexOf(folderId);

      const hasParent = idx < folderIds.length - 1;
      return new Response(
        JSON.stringify({
          id: folderId,
          name: `Folder ${idx}`,
          parents: hasParent ? [folderIds[idx + 1]] : [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const file = { id: "leaf-file", name: "file.txt", mimeType: "text/plain", parents: [folderIds[0]] };
    const path = await resolveFolderPath(file, "My Drive", "access-token", folderCache);

    // The path should exist (not throw) but have at most MAX_FOLDER_DEPTH=20 segments
    expect(typeof path).toBe("string");
    const segments = path.split(" / ");
    // "My Drive" is always first, then up to 20 folder names
    expect(segments.length).toBeLessThanOrEqual(21);
  });
});

describe("fetchFileContent — download caps", () => {
  it("skips a binary file whose declared size exceeds the extraction cap", async () => {
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => {
      throw new Error("fetch should not be called for oversized binary");
    });

    const file = {
      id: "big-xlsx",
      name: "huge.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: String(30 * 1024 * 1024),
    };

    const result = await fetchFileContent(file, "access-token", testLogger);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still skips a native text file whose declared size exceeds the download cap", async () => {
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => {
      throw new Error("fetch should not be called for oversized text");
    });

    const file = {
      id: "big-txt",
      name: "huge.txt",
      mimeType: "text/plain",
      size: String(201 * 1024 * 1024),
    };

    const result = await fetchFileContent(file, "access-token", testLogger);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("produces content and hash identical to whole-body reads for a small exported doc", async () => {
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => new Response("  Hello world  ", { status: 200 }));

    const file = {
      id: "doc-small",
      name: "Small Doc",
      mimeType: "application/vnd.google-apps.document",
    };

    const result = await fetchFileContent(file, "access-token", testLogger);
    expect(result).not.toBeNull();
    // truncateAndHash trims whitespace; bounded read consumes the whole small body,
    // so the output is byte-identical to reading response.text() in full.
    expect(result?.content).toBe("Hello world");
    expect(result?.hash).toBe(createHash("sha256").update("Hello world").digest("hex"));
  });

  it("stops reading and cancels the stream for an oversized exported doc", async () => {
    let pullCount = 0;
    let cancelled = false;
    const chunk = new Uint8Array(512 * 1024).fill(0x61);

    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount++;
          if (pullCount > 200) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200 });
    });

    const file = {
      id: "doc-huge",
      name: "Huge Sheet",
      mimeType: "application/vnd.google-apps.spreadsheet",
    };

    const result = await fetchFileContent(file, "access-token", testLogger);
    expect(result).not.toBeNull();
    // MAX_READ_BYTES is 2MB (4 × 512KB). With 512KB chunks the reader crosses the
    // ceiling after ~5 pulls, then cancels — nowhere near the 200-chunk source.
    expect(pullCount).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
  });
});
