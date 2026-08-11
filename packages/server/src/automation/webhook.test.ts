import { describe, expect, it } from "vitest";
import {
  addWebhookMetadata,
  buildAutomationWebhookUrl,
  isAutomationWebhookTrigger,
  parseAutomationTriggerConfig,
} from "./webhook";

describe("automation webhook contracts", () => {
  it("builds a stable URL from the configured public base URL", () => {
    expect(
      buildAutomationWebhookUrl("task/with spaces", {
        baseUrl: "https://sketch.example/",
      }),
    ).toBe("https://sketch.example/api/webhooks/wf/task%2Fwith%20spaces");
  });

  it("recognizes only the Sketch-owned webhook trigger", () => {
    expect(isAutomationWebhookTrigger({ type: "webhook" })).toBe(true);
    expect(isAutomationWebhookTrigger({ type: "canvas", componentKey: "webhook-trigger" })).toBe(false);
    expect(isAutomationWebhookTrigger({ type: "canvas", componentKey: "slack-new-message" })).toBe(false);
    expect(isAutomationWebhookTrigger({ type: "schedule" })).toBe(false);
  });

  it("reads the trigger from persisted workflow steps and ignores malformed values", () => {
    expect(
      parseAutomationTriggerConfig(
        JSON.stringify([
          { id: "trigger-1", type: "trigger", label: "Webhook", triggerConfig: { type: "webhook" } },
          { id: "action-1", type: "action", label: "Process payload" },
        ]),
        { scheduleType: "cron", scheduleValue: "* * * * *" },
      ),
    ).toEqual({ type: "webhook" });

    expect(
      parseAutomationTriggerConfig("not-json", { scheduleType: "external", scheduleValue: "webhook" }),
    ).toBeUndefined();
    expect(parseAutomationTriggerConfig(null, { scheduleType: "external", scheduleValue: "webhook" })).toEqual({
      type: "webhook",
    });
  });

  it("adds metadata only to the native endpoint", () => {
    expect(addWebhookMetadata({ type: "webhook" }, "task-1", { baseUrl: "https://sketch.example" })).toMatchObject({
      type: "webhook",
      webhookUrl: "https://sketch.example/api/webhooks/wf/task-1",
      webhookMethod: "POST",
      webhookContentType: "application/json",
    });
  });
});
