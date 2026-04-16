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

const ELLIPSIS = "...";

function renderLines(lines: string[]): string {
  return lines.join("\n");
}

function clipOversizedLine(line: string, charLimit: number): string {
  if (line.length <= charLimit) return line;
  if (charLimit <= ELLIPSIS.length) return ELLIPSIS.slice(0, charLimit);
  return `${line.slice(0, charLimit - ELLIPSIS.length)}${ELLIPSIS}`;
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

  const syncNow = async () => {
    clearPendingTimer();
    if (syncPromise) {
      await syncPromise;
      return;
    }

    syncPromise = (async () => {
      for (const segment of segments) {
        const text = renderLines(segment.lines);
        if (!text) continue;

        if (!segment.ref) {
          segment.ref = await params.postText(text);
          segment.syncedText = segment.ref ? text : null;
          continue;
        }

        if (segment.syncedText === text) continue;
        await params.editText(segment.ref, text);
        segment.syncedText = text;
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
    for (const rawLine of incomingLines) {
      const line = clipOversizedLine(rawLine, params.charLimit);
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
    const current = activeSegment();
    current.lines = incomingLines.map((line) => clipOversizedLine(line, params.charLimit));
    if (renderLines(current.lines).length > params.charLimit) {
      current.lines = [clipOversizedLine(renderLines(current.lines), params.charLimit)];
    }
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
