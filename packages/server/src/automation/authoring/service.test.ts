import { describe, expect, it, vi } from "vitest";
import { AutomationValidationError } from "../definition";
import { existingAutomationDefinition, poorGenerationFixtures, validAuthoringDefinition } from "./fixtures";
import {
  AutomationAuthoringTimeoutError,
  AutomationAuthoringValidationError,
  type StructuredAutomationAuthoringGenerator,
  createAutomationAuthoringService,
} from "./service";

function generation(output: unknown) {
  return {
    output,
    model: "anthropic/claude-sonnet-4.6",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    sdkCostUsd: 0,
  };
}

function createHarness(outputs: unknown[]) {
  const generate = vi.fn<StructuredAutomationAuthoringGenerator["generate"]>();
  for (const output of outputs) generate.mockResolvedValueOnce(generation(output));
  const telemetry = { recordAttempt: vi.fn().mockResolvedValue(undefined) };
  const service = createAutomationAuthoringService({
    loadProvider: async () => ({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.6",
      model: {} as never,
    }),
    generator: { generate },
    telemetry,
    configuredModelId: "anthropic/claude-sonnet-4.6",
  });
  return { service, generate, telemetry };
}

describe("automation authoring service", () => {
  it("creates a complete definition using bounded structured generation", async () => {
    const { service, generate } = createHarness([{ kind: "definition", definition: validAuthoringDefinition }]);

    const result = await service.create({
      request: "Every weekday at 9, send me a Linear digest",
      serverContext: {
        taskId: "task-new",
        platform: "slack",
        contextType: "dm",
        deliveryDefaults: {
          platform: "slack",
          targetType: "dm",
          targetId: "U123",
          threadTs: null,
          mode: "deliver",
        },
        timezone: "Asia/Kolkata",
        currentTime: "2026-07-27T12:00:00.000Z",
      },
      brokerCapable: true,
    });

    expect(result).toMatchObject({
      kind: "definition",
      definition: {
        title: "Weekday digest",
        stepContent: { digest: { taskId: "task-new" } },
      },
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create",
        attempt: 1,
        maxRetries: 0,
        timeoutMs: expect.any(Number),
        maxOutputTokens: 4096,
      }),
    );
    expect(generate.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
    expect(generate.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(30_000);
    expect(generate.mock.calls[0]?.[0].prompt).toContain('"brokerCapable":true');
  });

  it("returns one concise clarification without validating or drafting", async () => {
    const { service, generate } = createHarness([
      { kind: "clarification", question: "Which Slack channel should receive it?" },
    ]);

    await expect(
      service.create({
        request: "Send a digest",
        serverContext: {
          taskId: "task-new",
          platform: "slack",
          contextType: "dm",
          deliveryDefaults: {
            platform: "slack",
            targetType: "dm",
            targetId: "U123",
            threadTs: null,
            mode: "deliver",
          },
          timezone: "Asia/Kolkata",
          currentTime: "2026-07-27T12:00:00.000Z",
        },
        brokerCapable: true,
      }),
    ).resolves.toEqual({
      kind: "clarification",
      question: "Which Slack channel should receive it?",
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("edits from the complete existing definition and carries its execution model by stable step id", async () => {
    const edited = {
      ...validAuthoringDefinition,
      title: "Weekday leadership digest",
    };
    const { service, generate } = createHarness([{ kind: "definition", definition: edited }]);

    const result = await service.edit({
      request: "Rename it to Weekday leadership digest",
      existing: existingAutomationDefinition,
      brokerCapable: true,
    });

    expect(result).toMatchObject({
      kind: "definition",
      definition: {
        expectedRevision: 7,
        status: "active",
        title: "Weekday leadership digest",
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "digest",
            agentModel: "xiaomi/mimo-v2.5",
            agentSkills: ["daily-summary"],
            agentMcpServers: ["linear"],
          }),
        ]),
        stepContent: {
          digest: expect.objectContaining({
            content: "Summarize updates and call out blockers.",
            apps: ["linear"],
          }),
        },
      },
    });
    const call = generate.mock.calls[0]?.[0];
    expect(call?.prompt).toContain('"revision":7');
    expect(call?.prompt).toContain('"agentModel":"xiaomi/mimo-v2.5"');
    expect(call?.prompt).toContain('"brokerCapable":true');
  });

  it("preserves the server-owned operational status during edits", async () => {
    const { service } = createHarness([{ kind: "definition", definition: validAuthoringDefinition }]);

    const result = await service.edit({
      request: "Shorten the description",
      existing: { ...existingAutomationDefinition, status: "paused" },
      brokerCapable: true,
    });

    expect(result).toMatchObject({
      kind: "definition",
      definition: { status: "paused" },
    });
  });

  it("fails closed when a generated edit drops the stable ID of a model-pinned step", async () => {
    const renamedStep = {
      ...validAuthoringDefinition,
      steps: validAuthoringDefinition.steps.map((step) =>
        step.id === "digest" ? { ...step, id: "leadership-digest" } : step,
      ),
      edges: [{ id: "trigger-leadership-digest", from: "trigger", to: "leadership-digest" }],
      stepContent: {
        "leadership-digest": {
          ...validAuthoringDefinition.stepContent.digest,
          stepId: "leadership-digest",
        },
      },
    };
    const { service, generate } = createHarness([
      { kind: "definition", definition: renamedStep },
      { kind: "definition", definition: renamedStep },
    ]);

    await expect(
      service.edit({
        request: "Rename the digest label without changing its execution model",
        existing: existingAutomationDefinition,
        brokerCapable: true,
      }),
    ).rejects.toBeInstanceOf(AutomationAuthoringValidationError);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].prompt).toContain("PINNED_STEP_ID_REQUIRED");
  });

  it.each(poorGenerationFixtures)(
    "retries once when generated output has $expectedIssue",
    async ({ draft, expectedIssue }) => {
      const { service, generate, telemetry } = createHarness([
        { kind: "definition", definition: draft },
        { kind: "definition", definition: validAuthoringDefinition },
      ]);

      const result = await service.create({
        request: "Every weekday at 9, send me a digest",
        serverContext: {
          taskId: "task-new",
          platform: "slack",
          contextType: "dm",
          deliveryDefaults: {
            platform: "slack",
            targetType: "dm",
            targetId: "U123",
            threadTs: null,
            mode: "deliver",
          },
          timezone: "Asia/Kolkata",
          currentTime: "2026-07-27T12:00:00.000Z",
        },
        brokerCapable: true,
      });

      expect(result.kind).toBe("definition");
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, maxRetries: 0 });
      expect(generate.mock.calls[1]?.[0].prompt).toContain(expectedIssue);
      expect(generate.mock.calls[1]?.[0].prompt).toContain('"priorDraft"');
      expect(telemetry.recordAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, validationOutcome: "invalid" }),
      );
    },
  );

  it("fails after one validation retry without returning an invalid definition", async () => {
    const invalid = poorGenerationFixtures[0].draft;
    const { service, generate } = createHarness([
      { kind: "definition", definition: invalid },
      { kind: "definition", definition: invalid },
    ]);

    await expect(
      service.create({
        request: "Every weekday at 9, send me a digest",
        serverContext: {
          taskId: "task-new",
          platform: "slack",
          contextType: "dm",
          deliveryDefaults: {
            platform: "slack",
            targetType: "dm",
            targetId: "U123",
            threadTs: null,
            mode: "deliver",
          },
          timezone: "Asia/Kolkata",
          currentTime: "2026-07-27T12:00:00.000Z",
        },
        brokerCapable: true,
      }),
    ).rejects.toBeInstanceOf(AutomationAuthoringValidationError);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry provider failures", async () => {
    const generate = vi
      .fn<StructuredAutomationAuthoringGenerator["generate"]>()
      .mockRejectedValue(new Error("OpenRouter unavailable"));
    const service = createAutomationAuthoringService({
      loadProvider: async () => ({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.6",
        model: {} as never,
      }),
      generator: { generate },
      telemetry: { recordAttempt: vi.fn().mockResolvedValue(undefined) },
      configuredModelId: "anthropic/claude-sonnet-4.6",
    });

    await expect(
      service.create({
        request: "Create a digest",
        serverContext: {
          taskId: "task-new",
          platform: "slack",
          contextType: "dm",
          deliveryDefaults: {
            platform: "slack",
            targetType: "dm",
            targetId: "U123",
            threadTs: null,
            mode: "deliver",
          },
          timezone: "Asia/Kolkata",
          currentTime: "2026-07-27T12:00:00.000Z",
        },
        brokerCapable: true,
      }),
    ).rejects.toThrow("OpenRouter unavailable");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("shares one thirty-second deadline across the validation retry", async () => {
    let clock = 0;
    const generate = vi
      .fn<StructuredAutomationAuthoringGenerator["generate"]>()
      .mockImplementationOnce(async () => {
        clock = 25_000;
        return generation({ kind: "definition", definition: poorGenerationFixtures[0].draft });
      })
      .mockImplementationOnce(async () => generation({ kind: "definition", definition: validAuthoringDefinition }));
    const service = createAutomationAuthoringService({
      loadProvider: async () => ({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.6",
        model: {} as never,
      }),
      generator: { generate },
      telemetry: { recordAttempt: vi.fn().mockResolvedValue(undefined) },
      configuredModelId: "anthropic/claude-sonnet-4.6",
      now: () => clock,
    });

    await service.create({
      request: "Create a digest",
      serverContext: {
        taskId: "task-new",
        platform: "slack",
        contextType: "dm",
        deliveryDefaults: {
          platform: "slack",
          targetType: "dm",
          targetId: "U123",
          threadTs: null,
          mode: "deliver",
        },
        timezone: "Asia/Kolkata",
        currentTime: "2026-07-27T12:00:00.000Z",
      },
      brokerCapable: true,
    });

    expect(generate.mock.calls[0]?.[0].timeoutMs).toBe(30_000);
    expect(generate.mock.calls[1]?.[0].timeoutMs).toBe(5_000);
  });

  it("classifies provider aborts as a fail-closed timeout without retrying", async () => {
    const timeout = new Error("request aborted");
    timeout.name = "AbortError";
    const generate = vi.fn<StructuredAutomationAuthoringGenerator["generate"]>().mockRejectedValue(timeout);
    const telemetry = { recordAttempt: vi.fn().mockResolvedValue(undefined) };
    const service = createAutomationAuthoringService({
      loadProvider: async () => ({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.6",
        model: {} as never,
      }),
      generator: { generate },
      telemetry,
      configuredModelId: "anthropic/claude-sonnet-4.6",
    });

    await expect(
      service.create({
        request: "Create a digest",
        serverContext: {
          taskId: "task-new",
          platform: "slack",
          contextType: "dm",
          deliveryDefaults: {
            platform: "slack",
            targetType: "dm",
            targetId: "U123",
            threadTs: null,
            mode: "deliver",
          },
          timezone: "Asia/Kolkata",
          currentTime: "2026-07-27T12:00:00.000Z",
        },
        brokerCapable: true,
      }),
    ).rejects.toBeInstanceOf(AutomationAuthoringTimeoutError);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(telemetry.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ validationOutcome: "timeout" }));
  });

  it("uses existing graph validation before returning a generated definition", async () => {
    const { service } = createHarness([
      { kind: "definition", definition: poorGenerationFixtures[1].draft },
      { kind: "definition", definition: poorGenerationFixtures[1].draft },
    ]);

    try {
      await service.create({
        request: "Create a digest",
        serverContext: {
          taskId: "task-new",
          platform: "slack",
          contextType: "dm",
          deliveryDefaults: {
            platform: "slack",
            targetType: "dm",
            targetId: "U123",
            threadTs: null,
            mode: "deliver",
          },
          timezone: "Asia/Kolkata",
          currentTime: "2026-07-27T12:00:00.000Z",
        },
        brokerCapable: true,
      });
      throw new Error("expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationAuthoringValidationError);
      expect((error as AutomationAuthoringValidationError).cause).toBeInstanceOf(AutomationValidationError);
    }
  });
});
