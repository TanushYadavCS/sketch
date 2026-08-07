import { describe, expect, it, vi } from "vitest";
import type { CurrentAutomation } from "../../scheduler/types";
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
        maxOutputTokens: 8192,
      }),
    );
    expect(generate.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
    expect(generate.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(60_000);
    expect(generate.mock.calls[0]?.[0].prompt).toContain('"brokerCapable":true');
    expect(generate.mock.calls[0]?.[0].instructions).toContain("native Slack channel message trigger");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("server-authenticated localPath");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("ctx.tools");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("ctx.sketch and ctx.sketchTools are invalid");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("human-readable message string");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("JSON.stringify output");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("short headings and bullet lists");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("ctx.integrations.executeAction");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("fetch Slack urlPrivate without authentication");
    expect(generate.mock.calls[0]?.[0].instructions).toContain("Do not implement this as polling");
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

  it("gives code-heavy replacement edits enough output budget", async () => {
    const { service, generate } = createHarness([{ kind: "definition", definition: validAuthoringDefinition }]);
    const codeHeavyRequest = `Rewrite the action script using this runtime contract:\n${"return structuredResult;\n".repeat(300)}`;

    await service.edit({
      request: codeHeavyRequest,
      existing: existingAutomationDefinition,
      brokerCapable: true,
    });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "edit",
        maxOutputTokens: 8192,
        prompt: expect.stringContaining(JSON.stringify(codeHeavyRequest).slice(1, -1)),
      }),
    );
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

  it("passes structured current automation alignment and authoritative revision context to edits", async () => {
    const { service, generate } = createHarness([{ kind: "definition", definition: validAuthoringDefinition }]);
    const currentAutomation = {
      taskId: existingAutomationDefinition.id,
      revision: existingAutomationDefinition.revision,
      builderConversationId: "builder-conversation-1",
      builderState: {
        title: existingAutomationDefinition.title,
        description: existingAutomationDefinition.description,
        prompt: existingAutomationDefinition.prompt,
        scheduleType: existingAutomationDefinition.scheduleType,
        scheduleValue: existingAutomationDefinition.scheduleValue,
        timezone: existingAutomationDefinition.timezone,
        status: existingAutomationDefinition.status,
        delivery: existingAutomationDefinition.delivery,
        steps: existingAutomationDefinition.steps,
        edges: existingAutomationDefinition.edges,
        stepContent: {
          digest: {
            contentType: "prompt" as const,
            content: "Summarize updates and call out blockers.",
            apps: ["linear"],
          },
        },
      },
    } satisfies CurrentAutomation;

    await service.edit({
      request: "Make the filter stricter",
      existing: existingAutomationDefinition,
      brokerCapable: true,
      currentAutomation,
      expectedRevision: currentAutomation.revision,
      timezone: "Asia/Kolkata",
      currentTime: "2026-08-04T12:00:00.000Z",
    });

    const prompt = JSON.parse(generate.mock.calls[0]?.[0].prompt ?? "{}") as Record<string, unknown>;
    expect(prompt).toMatchObject({
      requestedChange: "Make the filter stricter",
      existingDefinition: { id: "task-123", revision: 7 },
      currentAutomation,
      serverContext: {
        taskId: "task-123",
        persistedRevision: 7,
        timezone: "Asia/Kolkata",
        currentTime: "2026-08-04T12:00:00.000Z",
      },
    });
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

  it("shares one sixty-second deadline across the validation retry", async () => {
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

    expect(generate.mock.calls[0]?.[0].timeoutMs).toBe(60_000);
    expect(generate.mock.calls[1]?.[0].timeoutMs).toBe(35_000);
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

  it("retries transient provider failures before giving up", async () => {
    const { service, generate, telemetry } = createHarness([]);
    const providerError = Object.assign(new Error("upstream unavailable"), {
      name: "APICallError",
      statusCode: 503,
    });
    generate
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce(generation({ kind: "definition", definition: validAuthoringDefinition }));

    const result = await service.create({
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

    expect(result.kind).toBe("definition");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(telemetry.recordAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ attempt: 1, validationOutcome: "provider_error" }),
    );
    expect(telemetry.recordAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attempt: 2, validationOutcome: "valid" }),
    );
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
