/**
 * Storage ceilings that model-facing tool schemas must advertise.
 *
 * zod renders a bare `.int()` into JSON Schema as `maximum: 9007199254740991`, and that
 * JSON Schema is what the model reads as the tool definition. An agent asked for an upper
 * bound will echo the advertised maximum back, so any field bound to a 32-bit column needs
 * an explicit `.max(INT4_MAX)` — otherwise the value overflows the bind parameter and the
 * driver error surfaces as tool output.
 */
export const INT4_MAX = 2_147_483_647;
