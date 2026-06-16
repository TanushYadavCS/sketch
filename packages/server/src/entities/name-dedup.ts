import { createHash } from "node:crypto";

export type CandidateValueKind = "name" | "alias";

export interface CandidatePoolEntry {
  entityId: string;
  valueKind: CandidateValueKind;
  value: string;
}

interface IndexedCandidatePoolEntry extends CandidatePoolEntry {
  entryKey: string;
}

export interface CandidatePool {
  byStrictKey: Map<string, CandidatePoolEntry[]>;
  shinglesByEntryKey: Map<string, Set<string>>;
  entriesByKey: Map<string, CandidatePoolEntry>;
  lshBucketsByBand: Map<string, string[]>;
  nextEntryId: number;
}

export interface DedupHit {
  entityId: string;
  score: number;
  valueKind: CandidateValueKind;
  value: string;
}

const DEFAULT_THRESHOLD = 0.85;
const SHINGLE_SIZE = 3;
const SIGNATURE_SIZE = 32;
const BAND_SIZE = 4;
const MAX_UINT64 = 0xffffffffffffffffn;
const BLAKE2B64_OUTPUT_LENGTH_SUPPORTED = canCreateBlake2b64();

export function normalizeStrict(name: string): string {
  return stripDomainSuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function normalizeFuzzy(name: string): string {
  return stripDomainSuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shingles(name: string, n = SHINGLE_SIZE): Set<string> {
  const normalized = normalizeFuzzy(name);
  const out = new Set<string>();
  if (!normalized) return out;
  if (normalized.length < n) {
    out.add(normalized);
    return out;
  }
  for (let i = 0; i <= normalized.length - n; i += 1) {
    out.add(normalized.slice(i, i + n));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function hasHighEntropy(normalized: string): boolean {
  const compact = normalized.replace(/\s+/g, "");
  if (!compact) return false;
  const counts = new Map<string, number>();
  for (const ch of compact) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / compact.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 1.5;
}

export function minhashSignature(values: Set<string>): BigUint64Array {
  const signature = new BigUint64Array(SIGNATURE_SIZE);
  signature.fill(MAX_UINT64);
  for (const value of values) {
    for (let seed = 0; seed < SIGNATURE_SIZE; seed += 1) {
      const hash = blake2b64(`${seed}:${value}`);
      if (hash < signature[seed]) signature[seed] = hash;
    }
  }
  return signature;
}

export function lshBands(signature: BigUint64Array, bandSize = BAND_SIZE): string[] {
  const bands: string[] = [];
  for (let start = 0; start < signature.length; start += bandSize) {
    const bandIndex = start / bandSize;
    const values = Array.from(signature.slice(start, start + bandSize), (value) =>
      value.toString(16).padStart(16, "0"),
    ).join(":");
    bands.push(`${bandIndex}:${values}`);
  }
  return bands;
}

export function buildCandidatePool(entries: CandidatePoolEntry[]): CandidatePool {
  const pool: CandidatePool = {
    byStrictKey: new Map(),
    shinglesByEntryKey: new Map(),
    entriesByKey: new Map(),
    lshBucketsByBand: new Map(),
    nextEntryId: 0,
  };
  addToCandidatePool(pool, entries);
  return pool;
}

export function addToCandidatePool(pool: CandidatePool, entries: CandidatePoolEntry[]): void {
  for (const indexed of indexEntries(entries, pool)) {
    const strictKey = normalizeStrict(indexed.value);
    if (strictKey) {
      const bucket = pool.byStrictKey.get(strictKey);
      if (bucket) bucket.push(indexed);
      else pool.byStrictKey.set(strictKey, [indexed]);
    }

    const entryShingles = shingles(indexed.value);
    pool.entriesByKey.set(indexed.entryKey, indexed);
    pool.shinglesByEntryKey.set(indexed.entryKey, entryShingles);
    if (!shouldUseMinhash(indexed.value, entryShingles)) continue;

    const signature = minhashSignature(entryShingles);
    for (const band of lshBands(signature)) {
      const bucket = pool.lshBucketsByBand.get(band);
      if (bucket) bucket.push(indexed.entryKey);
      else pool.lshBucketsByBand.set(band, [indexed.entryKey]);
    }
  }
}

export function removeFromCandidatePool(pool: CandidatePool, entityId: string): void {
  for (const [key, bucket] of pool.byStrictKey) {
    const filtered = bucket.filter((entry) => entry.entityId !== entityId);
    if (filtered.length === 0) pool.byStrictKey.delete(key);
    else if (filtered.length !== bucket.length) pool.byStrictKey.set(key, filtered);
  }

  const removedKeys = new Set<string>();
  for (const [entryKey, entry] of pool.entriesByKey) {
    if (entry.entityId === entityId) {
      removedKeys.add(entryKey);
      pool.entriesByKey.delete(entryKey);
      pool.shinglesByEntryKey.delete(entryKey);
    }
  }

  if (removedKeys.size === 0) return;
  for (const [band, bucket] of pool.lshBucketsByBand) {
    const filtered = bucket.filter((entryKey) => !removedKeys.has(entryKey));
    if (filtered.length === 0) pool.lshBucketsByBand.delete(band);
    else if (filtered.length !== bucket.length) pool.lshBucketsByBand.set(band, filtered);
  }
}

export function findStrictMatches(name: string, pool: CandidatePool): DedupHit[] {
  const matches = pool.byStrictKey.get(normalizeStrict(name)) ?? [];
  return dedupeEntityMatches(matches.map((entry) => ({ ...entry, score: 1 })));
}

export function findFuzzyMatches(name: string, pool: CandidatePool, opts: { threshold?: number } = {}): DedupHit[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const queryShingles = shingles(name);
  if (!shouldUseMinhash(name, queryShingles)) return [];

  const signature = minhashSignature(queryShingles);
  const candidateKeys = new Set<string>();
  for (const band of lshBands(signature)) {
    for (const entryKey of pool.lshBucketsByBand.get(band) ?? []) {
      candidateKeys.add(entryKey);
    }
  }

  const matches: DedupHit[] = [];
  for (const entryKey of candidateKeys) {
    const candidateShingles = pool.shinglesByEntryKey.get(entryKey);
    const candidate = pool.entriesByKey.get(entryKey);
    if (!candidateShingles || !candidate) continue;
    const score = jaccard(queryShingles, candidateShingles);
    if (score >= threshold) matches.push({ ...candidate, score });
  }
  return dedupeEntityMatches(matches).sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
}

export function findDedupCandidates(name: string, pool: CandidatePool, opts: { threshold?: number } = {}): DedupHit[] {
  const byEntity = new Map<string, DedupHit>();
  for (const match of [...findStrictMatches(name, pool), ...findFuzzyMatches(name, pool, opts)]) {
    const existing = byEntity.get(match.entityId);
    if (!existing || match.score > existing.score) byEntity.set(match.entityId, match);
  }
  return [...byEntity.values()].sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
}

export function findFuzzyMatch(name: string, pool: CandidatePool, opts: { threshold?: number } = {}): DedupHit | null {
  return findDedupCandidates(name, pool, opts)[0] ?? null;
}

function shouldUseMinhash(value: string, valueShingles: Set<string>): boolean {
  const normalized = normalizeFuzzy(value);
  if (valueShingles.size === 0) return false;
  if (normalized.length < 6 && normalized.split(" ").filter(Boolean).length < 2) return false;
  if (!hasHighEntropy(normalized)) return false;
  return true;
}

function indexEntries(entries: CandidatePoolEntry[], pool: CandidatePool): IndexedCandidatePoolEntry[] {
  return entries.map((entry) => ({
    ...entry,
    entryKey: `${entry.entityId}:${entry.valueKind}:${pool.nextEntryId++}`,
  }));
}

function dedupeEntityMatches(matches: DedupHit[]): DedupHit[] {
  const byEntity = new Map<string, DedupHit>();
  for (const match of matches) {
    const clean = {
      entityId: match.entityId,
      score: match.score,
      valueKind: match.valueKind,
      value: match.value,
    };
    const existing = byEntity.get(match.entityId);
    if (!existing || match.score > existing.score) byEntity.set(match.entityId, clean);
  }
  return [...byEntity.values()];
}

function blake2b64(value: string): bigint {
  const digest = createBlake2b64().update(value).digest();
  return digest.readBigUInt64BE(0);
}

function createBlake2b64() {
  return BLAKE2B64_OUTPUT_LENGTH_SUPPORTED ? createHash("blake2b512", { outputLength: 8 }) : createHash("blake2b512");
}

function canCreateBlake2b64(): boolean {
  try {
    createHash("blake2b512", { outputLength: 8 });
    return true;
  } catch {
    return false;
  }
}

function stripDomainSuffix(value: string): string {
  return value.trim().replace(/\.(com|org|net|io|ai|co|in|dev|app)\b\.?$/i, "");
}
