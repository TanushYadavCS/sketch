import { describe, expect, it, vi } from "vitest";
import { MAX_AUTOMATION_OUTPUT_BYTES, createAutomationCapabilityRegistry } from "./capabilities";

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    runId: "run-1",
    stepId: "step-1",
    creatorId: "user-1",
    creatorEmail: "owner@example.com",
    workspaceDir: "/tmp/sketch-automation",
    db: {} as never,
    userRepo: {
      list: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      getAllEmailsForUser: vi.fn().mockResolvedValue(["owner@example.com"]),
      findByExactName: vi.fn().mockResolvedValue({
        id: "user-2",
        name: "Alice Example",
        email: "alice@example.com",
        slack_user_id: "U123",
        whatsapp_number: null,
      }),
      searchByNamePrefix: vi.fn().mockResolvedValue([]),
      searchByNameSubstring: vi.fn().mockResolvedValue([]),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("automation Sketch capability registry", () => {
  it("exposes only the declared capabilities and records calls", async () => {
    const recordCall = vi.fn();
    const tools = createAutomationCapabilityRegistry().createTools({
      context: createContext({ recordCall }) as never,
      allowedTools: ["findTeammate"],
    });

    expect(tools.search).toBeUndefined();
    expect(tools.searchEntities).toBeUndefined();
    expect(tools.findTeammate).toBeDefined();

    await expect(tools.findTeammate?.({ queries: ["Alice"] })).resolves.toEqual({
      results: [
        {
          query: "Alice",
          matches: [
            expect.objectContaining({
              id: "user-2",
              name: "Alice Example",
              matchedBy: "exact_name",
            }),
          ],
        },
      ],
    });
    expect(recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        runId: "run-1",
        stepId: "step-1",
        capability: "findTeammate",
        status: "completed",
      }),
    );
  });

  it("rejects unbounded teammate queries before invoking a handler", async () => {
    const tools = createAutomationCapabilityRegistry().createTools({
      context: createContext() as never,
      allowedTools: ["findTeammate"],
    });

    await expect(tools.findTeammate?.({ queries: [" "] })).rejects.toThrow("values cannot be empty");
    await expect(tools.findTeammate?.({ queries: ["x".repeat(201)] })).rejects.toThrow("cannot exceed 200 characters");
  });

  it("rejects unbounded entity id filters before invoking a handler", async () => {
    const tools = createAutomationCapabilityRegistry().createTools({
      context: createContext() as never,
      allowedTools: ["search"],
    });

    await expect(
      tools.search?.({ query: "Acme", entityIds: Array.from({ length: 101 }, (_, index) => `entity-${index}`) }),
    ).rejects.toThrow("Entity ids supports at most 100 values");
    await expect(tools.search?.({ query: "Acme", entityIds: ["x".repeat(201)] })).rejects.toThrow(
      "cannot exceed 200 characters",
    );
  });

  it("rejects oversized structured capability output", async () => {
    const context = createContext();
    context.userRepo.findByExactName.mockResolvedValue({
      id: "user-2",
      name: "x".repeat(MAX_AUTOMATION_OUTPUT_BYTES),
      email: "alice@example.com",
      slack_user_id: "U123",
      whatsapp_number: null,
    });
    const tools = createAutomationCapabilityRegistry().createTools({
      context: context as never,
      allowedTools: ["findTeammate"],
    });

    await expect(tools.findTeammate?.({ queries: ["Alice"] })).rejects.toThrow(
      `Sketch capability output exceeds ${MAX_AUTOMATION_OUTPUT_BYTES} bytes`,
    );
  });

  it("fails when a structured capability is unavailable instead of returning an empty result", async () => {
    const onFailure = vi.fn();
    const tools = createAutomationCapabilityRegistry().createTools({
      context: createContext({ db: undefined, onFailure }) as never,
      allowedTools: ["searchEntities"],
    });

    await expect(tools.searchEntities?.({ queries: ["Acme"] })).rejects.toThrow("unavailable or invalid response");
    expect(onFailure).toHaveBeenCalledWith("searchEntities", expect.any(Error));
  });
});
