/**
 * Auxiliary LLM cost capture for an agent run.
 *
 * Transcription (Whisper) and vision are separate OpenRouter calls made during a
 * run, outside the Claude Agent SDK's own `total_cost_usd`. Their cost comes
 * straight from OpenRouter's `usage.cost` (correct for per-second Whisper and
 * token-based vision alike), so it is captured verbatim rather than recomputed
 * from the token-based price map. The per-call records feed the run's
 * `aux_cost_usd` total and the `sketch.aux_calls` breakdown on the span.
 *
 * `source` records whether the figure is OpenRouter's own (`openrouter`) or
 * missing from the response (`unknown`, contributing 0 to the total).
 */
export type AuxLlmOp = "transcription" | "vision";

export type AuxCostSource = "openrouter" | "unknown";

export interface AuxLlmCall {
  op: AuxLlmOp;
  model: string;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  seconds?: number;
  source: AuxCostSource;
}

export class AuxCostCollector {
  private calls: AuxLlmCall[] = [];

  collect(call: AuxLlmCall): void {
    this.calls.push(call);
  }

  drain(): AuxLlmCall[] {
    const calls = [...this.calls];
    this.calls = [];
    return calls;
  }
}

/** Sum of every captured aux call's cost, in USD. */
export function sumAuxCost(calls: AuxLlmCall[]): number {
  return calls.reduce((total, call) => total + (Number.isFinite(call.costUsd) ? call.costUsd : 0), 0);
}
