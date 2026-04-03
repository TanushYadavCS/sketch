/**
 * Tests for the tagging module.
 *
 * Focuses on extractDatesFromText — deterministic extraction of ISO dates
 * and quarter references from text content.
 */
import { describe, expect, it } from "vitest";
import { extractDatesFromText } from "./tagging";

describe("extractDatesFromText — quarter references", () => {
  it("Q1 ends on March 31", () => {
    const result = extractDatesFromText("Q1 2025 results");
    const tf = result.find((t) => t.context === "Q1 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-03-31");
  });

  it("Q2 ends on June 30", () => {
    const result = extractDatesFromText("Q2 2025 results");
    const tf = result.find((t) => t.context === "Q2 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-06-30");
  });

  it("Q3 ends on September 30", () => {
    const result = extractDatesFromText("Q3 2025 results");
    const tf = result.find((t) => t.context === "Q3 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-09-30");
  });

  it("Q4 ends on December 31", () => {
    const result = extractDatesFromText("Q4 2025 results");
    const tf = result.find((t) => t.context === "Q4 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-12-31");
  });

  it("Q1 starts on January 1", () => {
    const result = extractDatesFromText("Q1 2024 planning");
    const tf = result.find((t) => t.context === "Q1 2024");
    expect(tf?.startDate).toBe("2024-01-01");
  });

  it("Q4 starts on October 1", () => {
    const result = extractDatesFromText("Q4 2024 review");
    const tf = result.find((t) => t.context === "Q4 2024");
    expect(tf?.startDate).toBe("2024-10-01");
  });
});

describe("extractDatesFromText — ISO dates", () => {
  it("extracts a single ISO date", () => {
    const result = extractDatesFromText("Report dated 2025-01-15");
    expect(result).toHaveLength(1);
    expect(result[0].startDate).toBe("2025-01-15");
  });

  it("extracts a date range from multiple ISO dates", () => {
    const result = extractDatesFromText("Data from 2024-03-01 to 2024-06-30");
    expect(result).toHaveLength(1);
    expect(result[0].startDate).toBe("2024-03-01");
    expect(result[0].endDate).toBe("2024-06-30");
  });

  it("returns empty array for text with no dates", () => {
    const result = extractDatesFromText("No dates here at all");
    expect(result).toHaveLength(0);
  });
});
