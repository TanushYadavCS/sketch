import type { QueryClient } from "@tanstack/react-query";

export const AUTOMATION_QUERY_KEY = ["scheduled-tasks"] as const;
export const AUTOMATION_REFRESH_INTERVAL_MS = 5_000;
export const AUTOMATION_ACTIVE_RUN_REFRESH_INTERVAL_MS = 1_500;

export const automationDefinitionQueryKey = (taskId: string) => [...AUTOMATION_QUERY_KEY, taskId, "builder"] as const;
export const automationRunsQueryKey = (taskId: string) => ["automation-runs", taskId] as const;
export const automationStepContentQueryKey = (taskId: string) => ["automation-step-content", taskId] as const;

export function invalidateAutomationQueries(queryClient: QueryClient, taskIds: readonly string[] = []) {
  const uniqueTaskIds = [...new Set(taskIds.filter((taskId) => taskId.trim().length > 0))];
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: AUTOMATION_QUERY_KEY, exact: true }),
    ...uniqueTaskIds.flatMap((taskId) => [
      queryClient.invalidateQueries({ queryKey: automationDefinitionQueryKey(taskId), exact: true }),
      queryClient.invalidateQueries({ queryKey: automationRunsQueryKey(taskId), exact: true }),
      queryClient.invalidateQueries({ queryKey: automationStepContentQueryKey(taskId), exact: true }),
    ]),
  ]);
}
