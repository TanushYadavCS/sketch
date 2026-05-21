/**
 * Badge for the sidebar nav showing the count of pending entity-review
 * rows. Gated by `experimentalFlag` so it never polls when the feature
 * is off. Hidden on 0 or error — we don't surface network blips to users.
 */
import { api } from "@/lib/api";
import { Badge } from "@sketch/ui/components/badge";
import { useQuery } from "@tanstack/react-query";

interface SidebarReviewCountProps {
  enabled: boolean;
}

export function SidebarReviewCount({ enabled }: SidebarReviewCountProps) {
  const { data, isError } = useQuery({
    queryKey: ["entity-review", "count"],
    queryFn: async () => {
      const res = await api.entityReview.list({ limit: 0 });
      return res.total;
    },
    enabled,
    refetchInterval: 60_000,
    retry: 1,
  });

  if (!enabled || isError) return null;
  const total = data ?? 0;
  if (total <= 0) return null;
  return (
    <Badge variant="secondary" data-testid="review-count-badge">
      {total}
    </Badge>
  );
}
