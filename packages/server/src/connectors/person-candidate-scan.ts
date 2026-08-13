import type { Kysely } from "kysely";
import { whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";

export const PERSON_CANDIDATE_CAP = 50;

const DISTINCTIVE_HOLDER_CAP = 6;
const MAX_SCAN_CHARS = 32000;

export interface PersonCandidate {
  name: string;
  normalizedNameKey: string;
  tokens: Set<string>;
}

export interface PersonCandidateScan {
  candidatesByToken: Map<string, PersonCandidate[]>;
  holderCountByToken: Map<string, number>;
}

interface PersonRow {
  name: string;
}

function tokenizeLetters(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length >= 4);
}

function uniqueSortedTokens(value: string): string[] {
  return Array.from(new Set(tokenizeLetters(value))).sort((a, b) => a.localeCompare(b));
}

function normalizedNameKey(name: string): string {
  return uniqueSortedTokens(name).join(" ");
}

function parseParticipantNameKeys(participantBlock?: string): Set<string> {
  const keys = new Set<string>();
  if (!participantBlock) return keys;
  for (const line of participantBlock.split("\n")) {
    const match = line.match(/^\s*-\s+(.+?)\s+—\s+/);
    if (!match) continue;
    const key = normalizedNameKey(match[1]);
    if (key) keys.add(key);
  }
  return keys;
}

function hasAdjacentTokenPair(positionsByToken: Map<string, number[]>, tokens: Set<string>): boolean {
  const matched = Array.from(tokens);
  for (let i = 0; i < matched.length; i++) {
    const leftPositions = positionsByToken.get(matched[i]) ?? [];
    for (let j = i + 1; j < matched.length; j++) {
      const rightPositions = positionsByToken.get(matched[j]) ?? [];
      for (const left of leftPositions) {
        for (const right of rightPositions) {
          if (Math.abs(left - right) <= 2) return true;
        }
      }
    }
  }
  return false;
}

export async function buildPersonCandidateScan(db: Kysely<DB>): Promise<PersonCandidateScan> {
  const liveRows = (await db
    .selectFrom("entities")
    .select("name")
    .where("source_type", "=", "person")
    .where("status", "=", "confirmed")
    .where(whereLiveEntity())
    .execute()) as PersonRow[];
  const pendingRows = (await db
    .selectFrom("entity_review_queue")
    .select("proposed_name as name")
    .where("entity_type", "=", "person")
    .where("status", "=", "pending")
    .execute()) as PersonRow[];

  const candidatesByNameKey = new Map<string, PersonCandidate>();
  const holderKeysByToken = new Map<string, Set<string>>();

  for (const row of [...liveRows, ...pendingRows]) {
    const name = row.name.trim();
    if (!name) continue;
    const tokens = uniqueSortedTokens(name);
    if (tokens.length === 0) continue;
    const nameKey = tokens.join(" ");
    if (!candidatesByNameKey.has(nameKey)) {
      candidatesByNameKey.set(nameKey, {
        name,
        normalizedNameKey: nameKey,
        tokens: new Set(tokens),
      });
    }
    for (const token of tokens) {
      let holders = holderKeysByToken.get(token);
      if (!holders) {
        holders = new Set();
        holderKeysByToken.set(token, holders);
      }
      holders.add(nameKey);
    }
  }

  const candidatesByToken = new Map<string, PersonCandidate[]>();
  for (const candidate of candidatesByNameKey.values()) {
    for (const token of candidate.tokens) {
      const candidates = candidatesByToken.get(token) ?? [];
      candidates.push(candidate);
      candidatesByToken.set(token, candidates);
    }
  }

  const holderCountByToken = new Map<string, number>();
  for (const [token, holders] of holderKeysByToken) {
    holderCountByToken.set(token, holders.size);
  }

  return { candidatesByToken, holderCountByToken };
}

export function buildPersonCandidateBlock(
  scan: PersonCandidateScan | undefined,
  fileContent: string,
  opts: { participantBlock?: string } = {},
): string {
  if (!scan || scan.candidatesByToken.size === 0) return "";

  const textTokens = tokenizeLetters(fileContent.slice(0, MAX_SCAN_CHARS));
  const positionsByToken = new Map<string, number[]>();
  const matchedTokensByNameKey = new Map<string, Set<string>>();

  for (let index = 0; index < textTokens.length; index++) {
    const token = textTokens[index];
    const candidates = scan.candidatesByToken.get(token);
    if (!candidates) continue;
    const positions = positionsByToken.get(token) ?? [];
    positions.push(index);
    positionsByToken.set(token, positions);
    for (const candidate of candidates) {
      const matched = matchedTokensByNameKey.get(candidate.normalizedNameKey) ?? new Set<string>();
      matched.add(token);
      matchedTokensByNameKey.set(candidate.normalizedNameKey, matched);
    }
  }

  if (matchedTokensByNameKey.size === 0) return "";

  const participantNameKeys = parseParticipantNameKeys(opts.participantBlock);
  const offeredByNameKey = new Map<string, PersonCandidate>();

  for (const [nameKey, matchedTokens] of matchedTokensByNameKey) {
    if (participantNameKeys.has(nameKey)) continue;
    const candidate = Array.from(matchedTokens)
      .flatMap((token) => scan.candidatesByToken.get(token) ?? [])
      .find((entry) => entry.normalizedNameKey === nameKey);
    if (!candidate) continue;
    const hasDistinctiveToken = Array.from(matchedTokens).some(
      (token) => (scan.holderCountByToken.get(token) ?? 0) <= DISTINCTIVE_HOLDER_CAP,
    );
    if (!hasDistinctiveToken && !hasAdjacentTokenPair(positionsByToken, matchedTokens)) continue;
    offeredByNameKey.set(nameKey, candidate);
  }

  const offered = Array.from(offeredByNameKey.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, PERSON_CANDIDATE_CAP);
  if (offered.length === 0) return "";

  return `\nKnown people already in the register. Match document mentions to these canonical person names instead of creating duplicate people. Do not extract a listed person unless the document content supports that person.\n${offered.map((candidate) => `- ${candidate.name} (person)`).join("\n")}\n`;
}
