import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";

interface DiscardChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isNewSkill: boolean;
}

export function DiscardChangesDialog({ open, onOpenChange, onConfirm, isNewSkill }: DiscardChangesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            {isNewSkill ? "Discard this skill?" : "Discard changes?"}
          </DialogTitle>
          <DialogDescription className="text-sm">
            {isNewSkill
              ? "You haven\u2019t saved this skill yet. All content will be lost."
              : "You have unsaved changes that will be lost."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Keep editing
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
