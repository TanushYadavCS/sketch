import { describe, expect, it } from "vitest";
import { AutomationValidationError, validateAutomationBuilderSaveRequest } from "../definition";
import { poorGenerationFixtures } from "./fixtures";
import { automationAuthoringDefinitionSchema, toAutomationBuilderSaveRequest } from "./schema";

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
});
