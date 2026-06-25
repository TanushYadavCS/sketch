import { getHeader } from "./normalized-email";

export interface BulkClassification {
  isBulk: boolean;
  reason?: string;
}

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);
const ESP_MAILERS = ["mailchimp", "sendgrid", "mailgun", "mandrill", "constant contact", "hubspot"];

export function classifyBulk(headers: ReadonlyMap<string, string>): BulkClassification {
  if (getHeader(headers, "list-unsubscribe") || getHeader(headers, "list-unsubscribe-post")) {
    return { isBulk: true, reason: "list_unsubscribe" };
  }
  if (getHeader(headers, "list-id") || getHeader(headers, "list-post")) {
    return { isBulk: true, reason: "mailing_list" };
  }
  const autoSubmitted = getHeader(headers, "auto-submitted")?.toLowerCase();
  if (autoSubmitted?.startsWith("auto-")) {
    return { isBulk: true, reason: "auto_submitted" };
  }
  const precedence = getHeader(headers, "precedence")?.toLowerCase();
  if (precedence && BULK_PRECEDENCE.has(precedence)) {
    return { isBulk: true, reason: "precedence" };
  }
  if (getHeader(headers, "feedback-id") || getHeader(headers, "x-campaign-id") || getHeader(headers, "x-campaign")) {
    return { isBulk: true, reason: "campaign_header" };
  }
  const mailer = getHeader(headers, "x-mailer")?.toLowerCase() ?? "";
  if (ESP_MAILERS.some((marker) => mailer.includes(marker))) {
    return { isBulk: true, reason: "esp_mailer" };
  }
  return { isBulk: false };
}
