import { DailyBriefEmptyState } from "@/components/brief/brief-empty-state";
import { DailyBrief } from "@/components/brief/daily-brief";
import { applyTaskOverlayToBriefResponse } from "@/components/brief/task-overlay";
import type { DailyBriefResponse, TaskStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { chatPrefillTargetFromPrompt } from "@/lib/chat-target";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

export const DAILY_BRIEF_QUERY_KEY = ["daily-brief", "latest"];

export const homeRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home",
  component: HomePage,
});

export function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const briefQuery = useQuery({
    queryKey: DAILY_BRIEF_QUERY_KEY,
    queryFn: () => api.dailyBriefs.latest(),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
  });
  const generateMutation = useMutation({
    mutationFn: () => api.dailyBriefs.create({ briefDate: briefQuery.data?.briefDate }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DAILY_BRIEF_QUERY_KEY });
      toast.success("Daily Brief generation started");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to generate Daily Brief");
    },
  });

  const brief = briefQuery.data?.brief ?? null;
  const running = briefQuery.data?.running || generateMutation.isPending;

  const updateTaskStatusMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) => api.tasks.updateStatus(taskId, status),
    onSuccess: ({ task }) => {
      queryClient.setQueryData<DailyBriefResponse>(DAILY_BRIEF_QUERY_KEY, (current) =>
        current ? applyTaskOverlayToBriefResponse(current, task) : current,
      );
      void queryClient.invalidateQueries({ queryKey: DAILY_BRIEF_QUERY_KEY });
      toast.success("Task status updated");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update task status");
    },
  });
  const updatingTaskId = updateTaskStatusMutation.isPending
    ? (updateTaskStatusMutation.variables?.taskId ?? null)
    : null;

  return (
    <TabContentContainer className="mx-auto box-border min-h-[calc(100vh-3rem)] max-w-4xl px-5 py-10 sm:px-10 md:min-h-screen">
      {brief ? (
        <DailyBrief
          brief={brief}
          running={running}
          enabledSections={briefQuery.data?.enabledSections}
          calendarConnected={briefQuery.data?.calendarConnected}
          onOpenChat={(prompt) => {
            void navigate(chatPrefillTargetFromPrompt(prompt));
          }}
          onUpdateTaskStatus={(taskId, status) => updateTaskStatusMutation.mutate({ taskId, status })}
          updatingTaskId={updatingTaskId}
        />
      ) : (
        <DailyBriefEmptyState
          loading={briefQuery.isLoading}
          running={running}
          generating={generateMutation.isPending}
          onGenerate={() => generateMutation.mutate()}
        />
      )}
    </TabContentContainer>
  );
}
