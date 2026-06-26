import { DailyBriefEmptyState } from "@/components/brief/brief-empty-state";
import { DailyBrief } from "@/components/brief/daily-brief";
import { api } from "@/lib/api";
import { chatPrefillTargetFromPrompt } from "@/lib/chat-target";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

const DAILY_BRIEF_QUERY_KEY = ["daily-brief", "latest"];

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

  return (
    <TabContentContainer className="mx-auto box-border min-h-[calc(100vh-52px)] max-w-4xl px-5 py-10 sm:px-10">
      {brief ? (
        <DailyBrief
          brief={brief}
          running={running}
          enabledSections={briefQuery.data?.enabledSections}
          onOpenChat={(prompt) => {
            void navigate(chatPrefillTargetFromPrompt(prompt));
          }}
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
