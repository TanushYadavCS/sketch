import { ChatInput, type ChatInputProps } from "@/components/sketch/chat-input";
import { ChipRow, type ChipSuggestion } from "@/components/sketch/chip-row";
import { ConversationRow, type ConversationRowProps } from "@/components/sketch/conversation-row";
import { GreetingBar } from "@/components/sketch/greeting-bar";
import { type TileDef, TileGrid, getDefaultTiles } from "@/components/sketch/tile-grid";
import { SpinnerGapIcon } from "@phosphor-icons/react";
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
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { cn } from "@sketch/ui/lib/utils";
import { useRef, useState } from "react";

export interface HomePaneProps {
  firstName: string;
  recents?: ConversationRowProps[];
  onSubmit?: ChatInputProps["onSubmit"];
  onConversationIntent?: (conversationId: string) => void;
  onDeleteConversation?: (conversation: ConversationRowProps) => void;
  deletingConversationId?: string | null;
  tiles?: TileDef[];
}

export function HomePane({
  firstName,
  recents = [],
  onSubmit,
  onConversationIntent,
  onDeleteConversation,
  deletingConversationId,
  tiles: tilesProp,
}: HomePaneProps) {
  const tiles = tilesProp ?? getDefaultTiles();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [prefill, setPrefill] = useState<string>("");
  const [conversationToDelete, setConversationToDelete] = useState<ConversationRowProps | null>(null);

  function handleChip(chip: ChipSuggestion) {
    setPrefill(chip.prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleConfirmDelete() {
    if (!conversationToDelete) return;
    onDeleteConversation?.(conversationToDelete);
  }

  return (
    <TabContentContainer className="mx-auto box-content max-w-4xl px-10 py-8">
      <section className="flex flex-col">
        <GreetingBar firstName={firstName} />
        <div className="mt-7 flex flex-col gap-3">
          <ChatInput ref={inputRef} key={prefill} initialValue={prefill} onSubmit={onSubmit} />
          <ChipRow onPick={handleChip} />
        </div>
      </section>

      <div className="mt-7 flex flex-col gap-7">
        <QuickActions tiles={tiles} />
        <Recents
          conversations={recents}
          deletingConversationId={deletingConversationId}
          onConversationIntent={onConversationIntent}
          onDeleteConversation={onDeleteConversation ? setConversationToDelete : undefined}
        />
      </div>

      <DeleteConversationDialog
        conversation={conversationToDelete}
        isDeleting={!!conversationToDelete && deletingConversationId === conversationToDelete.id}
        onOpenChange={(open) => {
          if (!open) setConversationToDelete(null);
        }}
        onConfirm={handleConfirmDelete}
      />
    </TabContentContainer>
  );
}

interface QuickActionsProps {
  tiles: ReturnType<typeof getDefaultTiles>;
  className?: string;
}

function QuickActions({ tiles, className }: QuickActionsProps) {
  return (
    <section className={cn("flex flex-col", className)}>
      <div className="mb-[10px] flex items-baseline justify-between px-[6px]">
        <h2 className="font-mono text-xs uppercase text-foreground">Workspace</h2>
      </div>
      <TileGrid tiles={tiles} />
    </section>
  );
}

interface RecentsProps {
  conversations: ConversationRowProps[];
  deletingConversationId?: string | null;
  onConversationIntent?: (conversationId: string) => void;
  onDeleteConversation?: (conversation: ConversationRowProps) => void;
  className?: string;
}

function Recents({
  conversations,
  deletingConversationId,
  onConversationIntent,
  onDeleteConversation,
  className,
}: RecentsProps) {
  const items = conversations.slice(0, 5);
  return (
    <section className={cn("flex flex-col", className)}>
      <div className="mb-[10px] flex items-baseline justify-between px-[6px]">
        <h2 className="font-mono text-xs uppercase text-foreground">
          {conversations.length === 0 ? "Recents" : "Recent conversations"}
        </h2>
      </div>
      {items.length === 0 ? (
        <span className="px-[6px] text-[12px] text-muted-foreground">Your conversations will appear here</span>
      ) : (
        <div className="flex flex-col gap-[1px]">
          {items.map((item) => (
            <ConversationRow
              key={item.id}
              {...item}
              isDeleting={deletingConversationId === item.id}
              onConversationIntent={onConversationIntent}
              onDelete={onDeleteConversation ? () => onDeleteConversation(item) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DeleteConversationDialog({
  conversation,
  isDeleting,
  onOpenChange,
  onConfirm,
}: {
  conversation: ConversationRowProps | null;
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={!!conversation} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the chat from Recents and clears its saved conversation context.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
