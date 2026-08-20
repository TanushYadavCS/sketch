/**
 * Every vector the search scored, in cosine order.
 *
 * A file is reachable through four independent vectors — its content chunks, its name,
 * its summary and (for images) its file embedding — and its rank is decided by whichever
 * one scored best. This is the only place that shows which vector actually matched, on
 * what text, and at what distance. Green rows carried their file into the fusion; red
 * rows lost to a closer vector of the same file, whatever its source.
 */
import type { DevVectorChunkHit, DevVectorHitSource } from "@/lib/api";

const SOURCE_LABEL: Record<DevVectorHitSource, string> = {
  file_name: "File name",
  summary: "Summary",
  content: "Content",
  image: "Image",
};

/** Name and summary are the fields this feature added, so they read differently to a chunk. */
const SOURCE_STYLE: Record<DevVectorHitSource, string> = {
  file_name: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  summary: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  content: "bg-muted text-muted-foreground",
  image: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export function VectorChunks({ chunks }: { chunks: DevVectorChunkHit[] }) {
  if (chunks.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No vectors were scored — the vector arm did not run.</p>;
  }

  const selected = chunks.filter((chunk) => chunk.bestForFile).length;
  const bySource = chunks.reduce<Partial<Record<DevVectorHitSource, number>>>((acc, chunk) => {
    acc[chunk.source] = (acc[chunk.source] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <p className="mb-2 text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">{selected}</span> of the {chunks.length} vectors shown became
        their file&apos;s representative. Green carried its file into the fusion; red lost to a closer vector of the
        same file, so rank alone does not decide the colour.
      </p>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {(Object.keys(SOURCE_LABEL) as DevVectorHitSource[])
          .filter((source) => bySource[source])
          .map((source) => (
            <span key={source} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${SOURCE_STYLE[source]}`}>
              {SOURCE_LABEL[source]} {bySource[source]}
            </span>
          ))}
      </div>

      <div className="max-h-[26rem] overflow-y-auto rounded-md border border-border">
        {chunks.map((chunk) => (
          <div
            key={`${chunk.fileId}-${chunk.rank}`}
            className={`flex gap-3 border-b border-border px-3 py-2 last:border-b-0 ${
              chunk.bestForFile
                ? "border-l-2 border-l-emerald-500 bg-emerald-500/5"
                : "border-l-2 border-l-destructive/60 bg-destructive/5"
            }`}
          >
            <span className="w-6 shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">{chunk.rank}</span>
            <span className="min-w-0 flex-1">
              <span className="mb-0.5 flex items-center gap-1.5">
                <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${SOURCE_STYLE[chunk.source]}`}>
                  {SOURCE_LABEL[chunk.source]}
                </span>
              </span>
              <span className="block text-[12px] leading-relaxed">
                {chunk.chunkPreview || <span className="text-muted-foreground italic">no text — image vector</span>}
              </span>
              <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{chunk.fileId}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-mono text-[12px]">{chunk.similarity.toFixed(4)}</span>
              <span className="block font-mono text-[10px] text-muted-foreground">d {chunk.distance.toFixed(4)}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Similarity is 1 − cosine distance. Ranks are global across every vector and every source, so they can skip: each
        source is guaranteed a share of the rows shown, and within a source the vectors that won their file are kept
        first. Without that, one source with near-identical vectors — a corpus of templated file names, say — fills the
        list and hides the rest.
      </p>
    </div>
  );
}
