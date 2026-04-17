import { chunkText } from "../formatting/chunking";

export type ProgressTransportStrategy = "accumulate" | "replace";

export interface ProgressTransport {
  syncLines(lines: string[]): Promise<void>;
  flush(): Promise<void>;
}

interface Segment<TRef> {
  lines: string[];
  ref: TRef | null;
  syncedText: string | null;
}

interface CreateProgressTransportParams<TRef> {
  charLimit: number;
  throttleMs: number;
  strategy: ProgressTransportStrategy;
  postText: (text: string) => Promise<TRef | null>;
  editText: (ref: TRef, text: string) => Promise<void>;
}

function renderLines(lines: string[]): string {
  return lines.join("\n");
}

function splitOversizedText(text: string, charLimit: number): string[] {
  return chunkText(text, charLimit).filter((chunk) => chunk.length > 0);
}

const CLEARED_SEGMENT_TEXT = "\u200b";

function isMessageTooLongError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const candidate = err as {
    message?: unknown;
    data?: { error?: unknown };
  };

  return (
    candidate.data?.error === "msg_too_long" ||
    (typeof candidate.message === "string" && candidate.message.includes("msg_too_long"))
  );
}

export function createProgressTransport<TRef>(params: CreateProgressTransportParams<TRef>): ProgressTransport {
  const segments: Segment<TRef>[] = [{ lines: [], ref: null, syncedText: null }];
  let desiredLines: string[] = [];
  let lastSyncAt = 0;
  let syncPromise: Promise<void> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingTimer = () => {
    if (!pendingTimer) return;
    clearTimeout(pendingTimer);
    pendingTimer = null;
  };

  const activeSegment = () => segments[segments.length - 1] ?? segments[0];

  const buildDesiredSegments = (lines: string[]): string[][] => {
    if (lines.length === 0) return [];

    if (params.strategy === "replace") {
      return splitOversizedText(renderLines(lines), params.charLimit).map((chunk) => [chunk]);
    }

    const nextSegments: string[][] = [];
    for (const rawLine of lines.flatMap((line) => splitOversizedText(line, params.charLimit))) {
      const current = nextSegments[nextSegments.length - 1];
      if (!current) {
        nextSegments.push([rawLine]);
        continue;
      }

      const maybeExtended = [...current, rawLine];
      if (renderLines(maybeExtended).length <= params.charLimit) {
        current.push(rawLine);
      } else {
        nextSegments.push([rawLine]);
      }
    }
    return nextSegments;
  };

  const splitSegmentForRetry = (index: number, text: string): boolean => {
    if (text.length <= 1) return false;

    const retryLimit = Math.max(1, Math.min(params.charLimit, Math.floor(text.length / 2)));
    const chunks = splitOversizedText(text, retryLimit);
    if (chunks.length < 2) return false;

    const current = segments[index];
    if (!current) return false;

    segments.splice(
      index,
      1,
      ...chunks.map((chunk, chunkIndex) => ({
        lines: [chunk],
        ref: chunkIndex === 0 ? current.ref : null,
        syncedText: chunkIndex === 0 ? current.syncedText : null,
      })),
    );
    return true;
  };

  const syncNow = async () => {
    clearPendingTimer();
    if (syncPromise) {
      await syncPromise;
      return;
    }

    syncPromise = (async () => {
      const desiredSegments = buildDesiredSegments(desiredLines);
      const existingCount = segments.length;
      const targetCount = Math.max(existingCount, desiredSegments.length, 1);

      for (let index = 0; index < targetCount; index++) {
        if (!segments[index]) {
          segments[index] = { lines: [], ref: null, syncedText: null };
        }

        const desiredSegmentLines = desiredSegments[index];
        const segment = segments[index];
        if (!segment) continue;

        if (desiredSegmentLines) {
          segment.lines = desiredSegmentLines;
        } else {
          segment.lines = [];
        }
      }

      for (let index = 0; index < segments.length; ) {
        const segment = segments[index];
        if (!segment) {
          index++;
          continue;
        }

        const text = segment.lines.length > 0 ? renderLines(segment.lines) : segment.ref ? CLEARED_SEGMENT_TEXT : "";
        if (!text) {
          index++;
          continue;
        }

        if (!segment.ref) {
          try {
            segment.ref = await params.postText(text);
            segment.syncedText = segment.ref ? text : null;
            index++;
            continue;
          } catch (err) {
            if (isMessageTooLongError(err) && splitSegmentForRetry(index, text)) {
              continue;
            }
            throw err;
          }
        }

        if (segment.syncedText === text) {
          index++;
          continue;
        }

        try {
          await params.editText(segment.ref, text);
          segment.syncedText = text;
          index++;
        } catch (err) {
          if (isMessageTooLongError(err) && splitSegmentForRetry(index, text)) {
            continue;
          }
          throw err;
        }
      }

      while (segments.length > 1) {
        const last = segments[segments.length - 1];
        if (!last || last.ref || last.lines.length > 0) break;
        segments.pop();
      }

      lastSyncAt = Date.now();
    })();

    try {
      await syncPromise;
    } finally {
      syncPromise = null;
    }
  };

  const scheduleSync = async () => {
    const elapsed = Date.now() - lastSyncAt;
    if (elapsed >= params.throttleMs) {
      await syncNow();
      return;
    }

    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      void syncNow().catch(() => {});
    }, params.throttleMs - elapsed);
  };

  return {
    async syncLines(lines: string[]) {
      desiredLines = [...lines];
      await scheduleSync();
    },

    async flush() {
      await syncNow();
    },
  };
}
