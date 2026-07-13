/**
 * Heap sampling for phase-level memory observability.
 *
 * The process shares one heap across HTTP, Slack, agent runs, and sync, so
 * OOMs can't be attributed from crash dumps alone. Long-running phases
 * (connector sync, enrichment, materialization, agent runs) sample the heap
 * at their start and attach the delta to their completion log line, making
 * per-phase memory growth queryable in CloudWatch.
 */
const MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

export function heapUsedMb(): number {
  return toMb(process.memoryUsage().heapUsed);
}

/** Log fields for a phase completion line, given the phase-start sample. */
export function heapStats(startHeapUsedMb: number): {
  heapUsedMb: number;
  heapDeltaMb: number;
  rssMb: number;
} {
  const usage = process.memoryUsage();
  const heapUsedNow = toMb(usage.heapUsed);
  return {
    heapUsedMb: heapUsedNow,
    heapDeltaMb: Math.round((heapUsedNow - startHeapUsedMb) * 10) / 10,
    rssMb: toMb(usage.rss),
  };
}
