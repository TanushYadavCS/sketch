import { api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import type { McpServerRecord } from "@sketch/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

export function RemoveMcpDialog({
  server,
  onOpenChange,
  onSuccess,
}: {
  server: McpServerRecord | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const removeMutation = useMutation({
    mutationFn: () => api.mcpServers.remove(server?.id ?? ""),
    onSuccess: () => {
      toast.success(`${server?.displayName ?? "Server"} removed`);
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <AlertDialog open={!!server} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {server?.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will disconnect the MCP server. The agent will lose access to its tools.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => removeMutation.mutate()}
            disabled={removeMutation.isPending}
          >
            {removeMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Removing...
              </>
            ) : (
              "Remove"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
