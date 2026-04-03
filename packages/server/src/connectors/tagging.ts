/**
 * Deterministic content extraction helpers.
 *
 * Extracts timeframes from text using regex patterns.
 * No LLM calls — purely deterministic.
 */

/**
 * Simple date pattern extraction from text.
 * Finds ISO dates, MM/DD/YYYY, and quarter references.
 */
export function extractDatesFromText(
  text: string,
): Array<{ startDate: string; endDate?: string; context?: string }> {
  const timeframes: Array<{ startDate: string; endDate?: string; context?: string }> = [];
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
