const QUOTED_REPLY_PATTERNS = [
  /\nOn .+ wrote:\s*[\s\S]*$/im,
  /\n-{2,}\s*Original Message\s*-{2,}[\s\S]*$/im,
  /\nFrom:\s.+\nSent:\s.+\nTo:\s.+/im,
];

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function cleanEmailBody(input: { bodyText: string | null; bodyHtml: string | null }): string | null {
  const raw = input.bodyText?.trim() || (input.bodyHtml ? htmlToText(input.bodyHtml) : "");
  if (!raw.trim()) return null;
  let cleaned = raw;
  for (const pattern of QUOTED_REPLY_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || null;
}
