import { chunkText } from "../formatting/chunking";

export type ProgressTransportStrategy = "accumulate" | "replace";

export interface ProgressTransport {
  pushLines(lines: string[]): Promise<void>;
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
  let lastSyncAt = 0;
  let syncPromise: Promise<void> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingTimer = () => {
    if (!pendingTimer) return;
    clearTimeout(pendingTimer);
    pendingTimer = null;
  };

  const activeSegment = () => segments[segments.length - 1] ?? segments[0];

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
      for (let index = 0; index < segments.length; ) {
        const segment = segments[index];
        if (!segment) {
          index++;
          continue;
        }
        const text = renderLines(segment.lines);
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

  const appendAccumulateLines = async (incomingLines: string[]) => {
    for (const rawLine of incomingLines.flatMap((line) => splitOversizedText(line, params.charLimit))) {
      const line = rawLine;
      const current = activeSegment();
      const nextLines = current.lines.length > 0 ? [...current.lines, line] : [line];
      if (renderLines(nextLines).length <= params.charLimit) {
        current.lines = nextLines;
        continue;
      }

      if (current.lines.length > 0) {
        await syncNow();
      }

      segments.push({ lines: [line], ref: null, syncedText: null });
    }
  };

  const replaceLines = (incomingLines: string[]) => {
    if (incomingLines.length === 0) return;
    const current = activeSegment() ?? { lines: [], ref: null, syncedText: null };
    const nextText = renderLines(incomingLines);
    const chunks = splitOversizedText(nextText, params.charLimit);
    segments.splice(
      0,
      segments.length,
      ...(chunks.length > 0
        ? chunks.map((chunk, index) => ({
            lines: [chunk],
            ref: index === 0 ? current.ref : null,
            syncedText: index === 0 ? current.syncedText : null,
          }))
        : [{ lines: [], ref: current.ref, syncedText: current.syncedText }]),
    );
  };

  return {
    async pushLines(lines: string[]) {
      if (lines.length === 0) return;
      if (params.strategy === "replace") {
        replaceLines(lines);
      } else {
        await appendAccumulateLines(lines);
      }
      await scheduleSync();
    },

    async flush() {
      await syncNow();
    },
  };
}
