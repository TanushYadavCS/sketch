import { coerceMentionType, normalizeMentionType } from "./graph";
import { normalizeEntityMatchName } from "./match-normalize";

export interface LlmExtractedNormalization {
  raw_mention_type: string | null;
  normalized_subject_name: string | null;
  normalized_mention_name: string | null;
  mention_type: string | null;
}

/**
 * Projects the four normalization columns an `llm_extracted` fact needs so that
 * corroboration counting and third-party lookup run as indexed SQL. Each formula
 * preserves one existing consumer's exact interpretation rather than collapsing
 * their incompatible views into one:
 *
 * - `raw_mention_type` mirrors `buildActiveLlmFileCounts`, which keys the count
 *   map off the un-coerced `normalizeMentionType(raw.type)`; a null type means
 *   the row never contributed to a count and is excluded from the indexed query.
 * - `normalized_subject_name` is that same raw type applied to the subject, so an
 *   indexed `raw_mention_type, normalized_subject_name` group reproduces the map
 *   key. It is null when the raw type is null or the normalized name is empty
 *   (the JS map skipped both).
 * - `normalized_mention_name` mirrors `findLlmExtractedThirdPartyMention`, which
 *   normalizes `raw.mention` (falling back to the subject) under the raw type and
 *   still filters literal company/tool through `raw_mention_type`.
 * - `mention_type` carries the materializer's coerced view
 *   (`normalizeMentionType(coerceMentionType(subject, raw.type))`), including the
 *   tool denylist result, for parity with `materializeLlmExtractedFact` and for
 *   Fix 3 corroboration events. No 2b query reads it.
 */
export function projectLlmExtractedNormalization(
  subjectName: string | null,
  raw: Record<string, unknown>,
): LlmExtractedNormalization {
  const rawMentionType = normalizeMentionType(raw.type);
  const subject = subjectName ?? "";
  const mentionValue = typeof raw.mention === "string" ? raw.mention : subject;
  const coerced = normalizeMentionType(coerceMentionType(subject, String(raw.type ?? "")));
  return {
    raw_mention_type: rawMentionType,
    normalized_subject_name: rawMentionType ? normalizeEntityMatchName(rawMentionType, subject) || null : null,
    normalized_mention_name: normalizeEntityMatchName(rawMentionType ?? "", mentionValue) || null,
    mention_type: coerced,
  };
}
