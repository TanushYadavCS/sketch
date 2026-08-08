import { describe, expect, it } from "vitest";
import { AutomationValidationError, validateAutomationBuilderSaveRequest } from "../definition";
import { poorGenerationFixtures, validAuthoringDefinition } from "./fixtures";
import { automationAuthoringDefinitionSchema, toAutomationBuilderSaveRequest } from "./schema";

function gmailCanvasTriggerDefinition() {
  return {
    ...validAuthoringDefinition,
    scheduleType: "external" as const,
    scheduleValue: "canvas",
    steps: validAuthoringDefinition.steps.map((step) =>
      step.type === "trigger"
        ? {
            ...step,
            triggerConfig: {
              type: "canvas" as const,
              app: "gmail",
              eventDescription: "new invoice email",
              componentKey: "gmail.new_invoice_email",
            },
          }
        : step,
    ),
  };
}

describe("automation authoring deterministic evaluation fixtures", () => {
  it.each(poorGenerationFixtures)(
    "$name violates the $expectedIssue semantic invariant",
    ({ draft, expectedIssue }) => {
      const generated = automationAuthoringDefinitionSchema.parse(draft);
      const request = toAutomationBuilderSaveRequest(generated, { taskId: "eval-task", status: "active" });

      try {
        validateAutomationBuilderSaveRequest({ request, brokerCapable: true });
        throw new Error("expected fixture to violate an automation invariant");
      } catch (error) {
        expect(error).toBeInstanceOf(AutomationValidationError);
        expect((error as AutomationValidationError).issues.map((issue) => issue.code)).toContain(expectedIssue);
      }
    },
  );

  it("rejects a trigger that is outside the authoring capability set", () => {
    const generated = automationAuthoringDefinitionSchema.parse(gmailCanvasTriggerDefinition());
    const request = toAutomationBuilderSaveRequest(generated, { taskId: "eval-task", status: "active" });

    expect(() =>
      validateAutomationBuilderSaveRequest({
        request,
        brokerCapable: true,
        supportedTriggerTypes: ["schedule", "webhook", "slack_channel_message"],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "AutomationValidationError",
        issues: expect.arrayContaining([expect.objectContaining({ code: "UNSUPPORTED_TRIGGER" })]),
      }),
    );
  });
});
