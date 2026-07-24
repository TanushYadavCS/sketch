/**
 * Text chunking for embedding.
 *
 * Splits text into overlapping chunks suitable for embedding.
 * Uses a simple token estimation (1 token ≈ 4 chars) to avoid
 * depending on a tokenizer library.
 */

export interface Chunk {
  index: number;
  content: string;
  tokenCount: number;
}

interface ChunkOptions {
  /** Target tokens per chunk. Default: 500. */
  maxTokens?: number;
  /** Overlap tokens between chunks. Default: 50. */
  overlapTokens?: number;
}

/** Rough token estimate: 1 token ≈ 4 characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into overlapping chunks.
 *
 * Strategy: split on paragraph boundaries first, then sentence boundaries,
 * accumulating until we hit the token limit. This preserves natural text
 * structure better than fixed-size character splits.
 */
export function chunkText(text: string, opts?: ChunkOptions): Chunk[] {
  const maxTokens = opts?.maxTokens ?? 500;
  const overlapTokens = opts?.overlapTokens ?? 50;
  const maxChars = maxTokens * 4;
  const overlapChars = overlapTokens * 4;

  const trimmed = text.trim();
  if (!trimmed) return [];

  // Small enough for a single chunk
  if (estimateTokens(trimmed) <= maxTokens) {
    return [{ index: 0, content: trimmed, tokenCount: estimateTokens(trimmed) }];
  }

  // Split into paragraphs (double newline) then sentences as fallback
  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim());

  const chunks: Chunk[] = [];
  let current = "";
  let overlapBuffer = "";

  function flushChunk() {
    const content = current.trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        tokenCount: estimateTokens(content),
      });

      // Keep the tail for overlap with next chunk
      overlapBuffer = content.length > overlapChars ? content.slice(-overlapChars) : content;
    }
    current = overlapBuffer;
  }

  for (const para of paragraphs) {
    const paraWithSep = para.trim();

    if (current.length + paraWithSep.length + 2 > maxChars) {
      // This paragraph would exceed the limit

      if (current.length > overlapChars) {
        // Flush what we have
        flushChunk();
      }

      // If a single paragraph exceeds maxChars, split it by sentences, then by lines, then hard-split
      if (paraWithSep.length > maxChars) {
        const sentences = paraWithSep.split(/(?<=[.!?])\s+/);

        // If sentence splitting didn't help (e.g. CSV, code), split by lines
        const segments = sentences.length <= 1 && paraWithSep.includes("\n") ? paraWithSep.split("\n") : sentences;

        for (const segment of segments) {
          // If a single segment still exceeds maxChars, hard-split by character
          if (segment.length > maxChars) {
            let pos = 0;
            while (pos < segment.length) {
              const available = Math.max(1, maxChars - (current ? current.length + 1 : 0));
              const slice = segment.slice(pos, pos + available);
              if (current.length + slice.length + 1 > maxChars && current.length > overlapChars) {
                flushChunk();
              }
              current += (current ? " " : "") + slice;
              pos += slice.length;
              if (current.length >= maxChars - overlapChars) {
                flushChunk();
              }
            }
          } else {
            if (current.length + segment.length + 1 > maxChars && current.length > overlapChars) {
              flushChunk();
            }
            current += (current ? " " : "") + segment;
          }
        }
      } else {
        current += (current ? "\n\n" : "") + paraWithSep;
      }
    } else {
      current += (current ? "\n\n" : "") + paraWithSep;
    }
  }

  // Flush remaining
  if (current.trim() && current.trim() !== overlapBuffer.trim()) {
    const content = current.trim();
    chunks.push({
      index: chunks.length,
      content,
      tokenCount: estimateTokens(content),
    });
  }

  return chunks;
}
