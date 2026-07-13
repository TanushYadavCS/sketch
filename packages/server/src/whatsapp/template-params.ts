import type { WhatsAppTemplateParamValue } from "./templates";

export function sanitizeTemplateParamValue(value: WhatsAppTemplateParamValue): string {
  if (value == null) return "";
  return String(value)
    .replace(/[\n\r\t]+/gu, " ")
    .replace(/ {3,}/gu, "  ")
    .trim()
    .slice(0, 300);
}

export function mapTemplateParams(
  parameterMap: Record<string, string> | null,
  params: Record<string, WhatsAppTemplateParamValue>,
): Array<[string, string]> {
  const entries = parameterMap ? Object.entries(parameterMap) : Object.keys(params).map((key) => [key, key]);
  return entries.map(([providerName, logicalName]) => [providerName, sanitizeTemplateParamValue(params[logicalName])]);
}
