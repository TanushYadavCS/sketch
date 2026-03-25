import { api } from "@/lib/api";
import { CheckIcon, SpinnerGapIcon, XCircleIcon } from "@phosphor-icons/react";
/**
 * Shared connection-test state machine and UI used by all server/provider dialogs.
 */
import { Button } from "@sketch/ui/components/button";
import { useCallback, useState } from "react";

export type TestState = "idle" | "testing" | "success" | "fail";

/**
 * Encapsulates the "test MCP connection" state machine used by
 * both the Add and Edit server/provider dialogs.
 */
export function useConnectionTest() {
  const [testState, setTestState] = useState<TestState>("idle");
  const [testResult, setTestResult] = useState<{ toolCount?: number; error?: string }>({});

  const reset = useCallback(() => {
    setTestState("idle");
    setTestResult({});
  }, []);

  const runTest = useCallback(async (urlOrServerId: string, credentials?: string) => {
    setTestState("testing");
    try {
      const result =
        credentials !== undefined
          ? await api.mcpServers.testConnection(urlOrServerId, credentials)
          : await api.mcpServers.testConnectionById(urlOrServerId);
      if (result.status === "ok") {
        setTestState("success");
        setTestResult({ toolCount: result.toolCount });
      } else {
        setTestState("fail");
        setTestResult({ error: result.error });
      }
    } catch {
      setTestState("fail");
      setTestResult({ error: "Could not reach server" });
    }
  }, []);

  return { testState, testResult, reset, runTest, resetToIdle: () => setTestState("idle") };
}

export function ConnectionTestSection({
  testState,
  testResult,
  onTest,
  disabled,
}: {
  testState: TestState;
  testResult: { toolCount?: number; error?: string };
  onTest: () => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={onTest} disabled={disabled || testState === "testing"}>
        {testState === "testing" ? (
          <>
            <SpinnerGapIcon size={14} className="animate-spin" />
            Testing...
          </>
        ) : (
          "Test connection"
        )}
      </Button>

      {testState === "success" && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon size={14} weight="bold" />
          Connected{testResult.toolCount != null ? ` -- ${testResult.toolCount} tools available` : ""}
        </p>
      )}
      {testState === "fail" && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <XCircleIcon size={14} weight="bold" />
          {testResult.error ?? "Could not reach server. Check the URL and try again."}
        </p>
      )}
    </div>
  );
}
