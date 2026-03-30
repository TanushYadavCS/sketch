/**
 * Smart tagging pipeline.
 *
 * Two paths:
 * - Structured data (CSV/Sheets): deterministic extraction from headers, no LLM
 * - Unstructured docs: LLM-based tag + timeframe + summary extraction
 *
 * Batches large documents to stay within context limits.
 */
import type { Chunk } from "./chunking";

export interface FileContext {
  sourcePath?: string | null;
  createdAt?: string | null;
  modifiedAt?: string | null;
  wordCount?: number;
  sharedWith?: string[];
  siblingFileNames?: string[];
}

export interface TaggingResult {
  tags: string[];
  summary: string;
  timeframes: Array<{
    startDate: string;
    endDate?: string;
    context?: string;
  }>;
  entityLinks: Array<{
    entityName: string;
    entityId: string;
    chunkIndex: number;
  }>;
  newPeople: Array<{
    name: string;
    contextHint: string;
  }>;
  newEntities: Array<{
    name: string;
    type: string;
    contextHint: string;
  }>;
}

/**
 * Extract tags from structured data (CSV/spreadsheet content).
 * No LLM call — purely deterministic.
 */
export function tagStructuredContent(content: string, fileName: string, sourcePath?: string | null): TaggingResult {
  // For XLSX: content has "## SheetName\n<csv rows>" per sheet.
  // For CSV: content is raw rows with no sheet headers.
  // We scan ALL lines for sheet headers but only keep the header row + a few sample rows per sheet.
  const SAMPLE_ROWS_PER_SHEET = 10;
  const allLines = content.split("\n");

  if (allLines.length === 0 || !allLines.some((l) => l.trim())) {
    return {
      tags: [],
      summary: `Empty spreadsheet: ${fileName}`,
      timeframes: [],
      entityLinks: [],
      newPeople: [],
      newEntities: [],
    };
  }

  // First pass: find all sheets, capture header + sample rows, count total rows per sheet
  const sheets: Array<{ name: string; headers: string[]; rowCount: number; sampleLines: string[] }> = [];
  let currentSheet: { name: string; lines: string[]; rowCount: number; gotEnough: boolean } | null = null;

  for (const line of allLines) {
    if (line.startsWith("## ")) {
      // Flush previous sheet
      if (currentSheet) {
        sheets.push(parseSheetWithCount(currentSheet));
      }
      currentSheet = { name: line.slice(3).trim(), lines: [], rowCount: 0, gotEnough: false };
    } else if (line.trim()) {
      if (!currentSheet) {
        // No sheet headers (plain CSV) — treat as single sheet
        currentSheet = { name: fileName.replace(/\.[^.]+$/, ""), lines: [], rowCount: 0, gotEnough: false };
      }
      currentSheet.rowCount++;
      // Keep header row (first) + sample rows
      if (!currentSheet.gotEnough) {
        currentSheet.lines.push(line);
        if (currentSheet.lines.length >= SAMPLE_ROWS_PER_SHEET + 1) {
          currentSheet.gotEnough = true;
        }
      }
    }
  }
  if (currentSheet) {
    sheets.push(parseSheetWithCount(currentSheet));
  }

  // Collect tags from headers and sheet names
  const tags = new Set<string>();
  for (const sheet of sheets) {
    tags.add(sheet.name.toLowerCase());
    for (const header of sheet.headers) {
      const cleaned = header.toLowerCase().trim();
      if (cleaned && cleaned.length > 1 && cleaned.length < 50) {
        tags.add(cleaned);
      }
    }
  }

  // Detect date values from sample lines only
  const sampleContent = sheets.flatMap((s) => s.sampleLines).join("\n");
  const timeframes = extractDatesFromText(sampleContent);

  // Build summary
  const totalRows = sheets.reduce((sum, s) => sum + s.rowCount, 0);
  const sheetDesc = sheets
    .map((s) => `${s.name} (${s.rowCount.toLocaleString()} rows, columns: ${s.headers.join(", ")})`)
    .join("; ");
  const summary = `Spreadsheet with ${sheets.length} tab(s): ${sheetDesc}. ${totalRows.toLocaleString()} total rows.`;

  return {
    tags: [...tags].slice(0, 30),
    summary: summary.slice(0, 1000),
    timeframes,
    entityLinks: [],
    newPeople: [],
    newEntities: [],
  };
}

function parseSheetWithCount(sheet: {
  name: string;
  lines: string[];
  rowCount: number;
}): { name: string; headers: string[]; rowCount: number; sampleLines: string[] } {
  const headers = sheet.lines.length > 0 ? sheet.lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "")) : [];

  return {
    name: sheet.name,
    headers: headers.filter(Boolean),
    rowCount: Math.max(0, sheet.rowCount - 1), // subtract header row
    sampleLines: sheet.lines,
  };
}

/**
 * Deterministic tagging for short content (under ~100 words).
 * No LLM call — derives tags from file name, source path, and content.
 * Uses the content itself as the summary since it's short enough.
 */
export function tagShortContent(content: string, fileName: string, _sourcePath?: string | null): TaggingResult {
  const tags = new Set<string>();

  // Extract meaningful words from filename (skip very short/common words)
  const nameWithoutExt = fileName.replace(/\.[^.]+$/, "");
  const words = nameWithoutExt.split(/[-_\s]+/).filter((w) => w.length > 2);
  for (const word of words.slice(0, 5)) {
    tags.add(word.toLowerCase());
  }

  const timeframes = extractDatesFromText(content);

  // Use content as summary, truncated
  const summary = content.replace(/\s+/g, " ").trim().slice(0, 500) || `Short document: ${fileName}`;

  return {
    tags: [...tags].slice(0, 15),
    summary,
    timeframes,
    entityLinks: [],
    newPeople: [],
    newEntities: [],
  };
}

/**
 * Build the LLM prompt for extracting tags, timeframes, and summary from document chunks.
 */
export function buildTaggingPrompt(
  chunks: Chunk[],
  fileName: string,
  orgContext?: string,
  fileContext?: FileContext,
  knownEntitiesBlock?: string,
): string {
  const chunkTexts = chunks.map((c) => `--- Section ${c.index + 1} ---\n${c.content}`).join("\n\n");

  const contextLines: string[] = [];
  if (orgContext) contextLines.push(`Organisation: ${orgContext}`);
  if (fileContext?.sourcePath) contextLines.push(`File location: ${fileContext.sourcePath}`);
  if (fileContext?.createdAt) contextLines.push(`Created: ${fileContext.createdAt}`);
  if (fileContext?.modifiedAt) contextLines.push(`Last modified: ${fileContext.modifiedAt}`);
  if (fileContext?.wordCount) contextLines.push(`Document size: ~${fileContext.wordCount} words`);
  if (fileContext?.sharedWith && fileContext.sharedWith.length > 0) {
    contextLines.push(`Shared with: ${fileContext.sharedWith.join(", ")}`);
  }
  if (fileContext?.siblingFileNames && fileContext.siblingFileNames.length > 0) {
    contextLines.push(`Other files in same folder: ${fileContext.siblingFileNames.join(", ")}`);
  }
  const contextBlock =
    contextLines.length > 0
      ? `\nContext (use this to understand what the document means to the team):\n${contextLines.join("\n")}\n`
      : "";

  const entityBlock = knownEntitiesBlock ?? "";

  return `Extract metadata from this document "${fileName}".
${contextBlock}${entityBlock}
Respond with ONLY valid JSON matching this schema:
{
  "summary": "2-3 sentence summary",
  "temporal_references": [
    { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD or null", "context": "what this date refers to" }
  ],
  "entity_links": [
    { "entity_name": "name from known entities list", "entity_id": "id from known entities list", "chunk_index": 0 }
  ],
  "new_people": [
    { "name": "Person Name", "context_hint": "mentioned as assignee / discussed as stakeholder / etc." }
  ],
  "new_entities": [
    { "name": "Entity Name", "type": "company | product | project | team | client", "context_hint": "described as client / mentioned as partner / etc." }
  ]
}

Summary: 2-3 sentences written from the perspective of someone inside the organisation. What role does this document play? What key decisions, conclusions, or outcomes does it capture? Write it so a teammate can decide "yes, this is the doc I was looking for" without opening it.

Temporal references: any specific dates, quarters, months, or time periods mentioned. Use ISO format. Q1 2025 = start 2025-01-01, end 2025-03-31. Empty array if none found.

Entity linking: Match the document content to known entities listed above. For each match, include the entity_name, entity_id, and the chunk_index (0-based) where the entity is most relevant. Consider abbreviations, acronyms, and informal references. Only include entities that are genuinely relevant to this document — not every mention.

New people: List any person names mentioned in the document that do NOT appear in the known entities list. Include a context_hint explaining how they're referenced (e.g. "assignee", "attendee", "stakeholder", "author"). Skip generic roles like "the team" or "everyone".

New entities: List companies, products, projects, clients, or teams that the ORGANISATION DIRECTLY WORKS WITH — clients, partners, internal projects, owned products. Use the file location, org name, and document context to judge relevance.

Rules:
- A blog post at "Marketing / Blog Calendar" comparing competitor tools → the competitors are NOT new entities (they're just referenced). Only the org's own product is relevant.
- A meeting note mentioning "call with Acme Corp about SOW" → Acme Corp IS a new entity (client relationship).
- A task description referencing Slack/Jira/Google Sheets as tools used → NOT new entities (generic tooling, not business relationships).
- When in doubt, DO NOT include. False positives are worse than missing an entity.

Skip: entities already in the known entities list, generic SaaS products merely referenced or compared, industry terms, media platforms used as sources (Reddit, LinkedIn, G2).

Document content:
${chunkTexts}`;
}

/**
 * Build the rollup prompt for merging batch tagging results into document-level metadata.
 */
export function buildRollupPrompt(
  batchResults: Array<{ tags: string[]; summary: string; temporal_references: unknown[] }>,
  fileName: string,
): string {
  return `Merge these batch extraction results into a single document-level summary for "${fileName}".

Batch results:
${JSON.stringify(batchResults, null, 2)}

Respond with ONLY valid JSON:
{
  "summary": "2-3 sentence document summary combining all batches",
  "temporal_references": [
    { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD or null", "context": "description" }
  ],
  "entity_links": [
    { "entity_name": "name", "entity_id": "id", "chunk_index": 0 }
  ],
  "new_people": [
    { "name": "Person Name", "context_hint": "role or context" }
  ],
  "new_entities": [
    { "name": "Entity Name", "type": "company | product | project | team | client", "context_hint": "context" }
  ]
}

Deduplicate temporal references, entity links, new_people, and new_entities. Keep the most relevant entity links.`;
}

/**
 * Parse LLM JSON response for tagging. Lenient — handles common LLM output quirks.
 */
export function parseTaggingResponse(response: string): TaggingResult | null {
  try {
    // Strip markdown code fences if present
    const cleaned = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    return {
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === "string") : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      timeframes: Array.isArray(parsed.temporal_references)
        ? parsed.temporal_references
            .filter((t: Record<string, unknown>) => t && typeof t.start_date === "string")
            .map((t: Record<string, unknown>) => ({
              startDate: t.start_date as string,
              endDate: typeof t.end_date === "string" ? t.end_date : undefined,
              context: typeof t.context === "string" ? t.context : undefined,
            }))
        : [],
      entityLinks: Array.isArray(parsed.entity_links)
        ? parsed.entity_links
            .filter(
              (e: Record<string, unknown>) => e && typeof e.entity_name === "string" && typeof e.entity_id === "string",
            )
            .map((e: Record<string, unknown>) => ({
              entityName: e.entity_name as string,
              entityId: e.entity_id as string,
              chunkIndex: typeof e.chunk_index === "number" ? e.chunk_index : 0,
            }))
        : [],
      newPeople: Array.isArray(parsed.new_people)
        ? parsed.new_people
            .filter((p: Record<string, unknown>) => p && typeof p.name === "string")
            .map((p: Record<string, unknown>) => ({
              name: p.name as string,
              contextHint: typeof p.context_hint === "string" ? p.context_hint : "",
            }))
        : [],
      newEntities: Array.isArray(parsed.new_entities)
        ? parsed.new_entities
            .filter((e: Record<string, unknown>) => e && typeof e.name === "string")
            .map((e: Record<string, unknown>) => ({
              name: e.name as string,
              type: typeof e.type === "string" ? e.type : "unknown",
              contextHint: typeof e.context_hint === "string" ? e.context_hint : "",
            }))
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Simple date pattern extraction for structured data.
 * Finds ISO dates, MM/DD/YYYY, and quarter references.
 */
function extractDatesFromText(text: string): TaggingResult["timeframes"] {
  const timeframes: TaggingResult["timeframes"] = [];
  const seen = new Set<string>();

  // ISO dates: YYYY-MM-DD
  const isoMatches = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (isoMatches) {
    const dates = [...new Set(isoMatches)].sort();
    if (dates.length > 0) {
      const key = `${dates[0]}-${dates[dates.length - 1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        timeframes.push({
          startDate: dates[0],
          endDate: dates.length > 1 ? dates[dates.length - 1] : undefined,
          context: "date range in data",
        });
      }
    }
  }

  // Quarter references: Q1 2025, Q2 2024, etc.
  const quarterMatches = text.match(/\bQ([1-4])\s*(\d{4})\b/gi);
  if (quarterMatches) {
    for (const match of [...new Set(quarterMatches)]) {
      const qMatch = match.match(/Q([1-4])\s*(\d{4})/i);
      if (qMatch) {
        const q = Number.parseInt(qMatch[1]);
        const year = qMatch[2];
        const startMonth = String((q - 1) * 3 + 1).padStart(2, "0");
        const endMonth = String(q * 3).padStart(2, "0");
        const endDay = ({ 3: "31", 6: "30", 9: "30", 12: "31" } as Record<number, string>)[q * 3] ?? "31";
        const key = `${year}-Q${q}`;
        if (!seen.has(key)) {
          seen.add(key);
          timeframes.push({
            startDate: `${year}-${startMonth}-01`,
            endDate: `${year}-${endMonth}-${endDay}`,
            context: `Q${q} ${year}`,
          });
        }
      }
    }
  }

  return timeframes.slice(0, 10);
}
