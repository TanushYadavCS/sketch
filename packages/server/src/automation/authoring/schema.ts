import {
  type AutomationBuilderSaveRequest,
  automationBuilderSaveRequestSchema,
  automationStepContentSchema,
  workflowStepSchema,
} from "@sketch/shared";
import { z } from "zod";

export const automationAuthoringStepSchema = workflowStepSchema.omit({ agentModel: true }).strict();

export const automationAuthoringStepContentSchema = automationStepContentSchema
  .omit({ taskId: true, updatedAt: true })
  .strict();

export const automationAuthoringDefinitionSchema = automationBuilderSaveRequestSchema
  .omit({
    expectedRevision: true,
    status: true,
    steps: true,
    stepContent: true,
  })
  .extend({
    steps: z.array(automationAuthoringStepSchema).min(2),
    stepContent: z.record(z.string(), automationAuthoringStepContentSchema),
  })
  .strict()
  .superRefine((definition, context) => {
    const stepIds = new Set(definition.steps.map((step) => step.id));
    for (const [key, content] of Object.entries(definition.stepContent)) {
      if (key !== content.stepId) {
        context.addIssue({
          code: "custom",
          path: ["stepContent", key, "stepId"],
          message: "Step content key must match stepId",
        });
      }
      if (!stepIds.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["stepContent", key],
          message: "Step content must belong to a generated step",
        });
      }
    }
  });

/**
 * Claude's native structured-output subset rejects constraints in the complete
 * authoring schema. Carry definitions as JSON text inside a strict flat object,
 * then validate the decoded value against the complete application schema.
 */
export const automationAuthoringTransportSchema = z
  .object({
    kind: z.enum(["definition", "clarification"]),
    definitionJson: z.string(),
    question: z.string(),
  })
  .strict();

export const automationAuthoringOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("definition"),
      definition: automationAuthoringDefinitionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clarification"),
      question: z.string().trim().min(1).max(240),
    })
    .strict(),
]);

export type AutomationAuthoringDefinition = z.infer<typeof automationAuthoringDefinitionSchema>;
export type AutomationAuthoringOutput = z.infer<typeof automationAuthoringOutputSchema>;

export function toAutomationBuilderSaveRequest(
  definition: AutomationAuthoringDefinition,
  server: {
    taskId: string;
    status: AutomationBuilderSaveRequest["status"];
    expectedRevision?: number;
  },
): AutomationBuilderSaveRequest {
  return {
    ...definition,
    status: server.status,
    expectedRevision: server.expectedRevision,
    stepContent: Object.fromEntries(
      Object.entries(definition.stepContent).map(([key, content]) => [
        key,
        {
          ...content,
          taskId: server.taskId,
        },
      ]),
    ),
  };
}
