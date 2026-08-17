/**
 * WhatsApp identity review — folds unidentified WhatsApp contacts into the
 * existing "Needs your review" queue.
 *
 * When a WhatsApp group is indexed, every unknown participant is auto-minted as
 * a person entity named by its raw phone/LID (`projectWhatsAppRosterPerson` on
 * the server). Those people already exist in the graph — they just have no human
 * name yet. This surface lets an admin put a name to them, leading with the
 * GROUPS the contact appears in (the recognizable signal) rather than the LID or
 * masked number, which no human can map on sight.
 *
 * Backed by `GET /api/entities/whatsapp/identities`, which returns only contacts
 * the caller shares a group with — an admin can never be asked to name someone
 * whose messages they have no right to read. The actions map onto existing
 * endpoints: Save is a rename plus optional contact points, Merge folds the
 * placeholder into a person you already know, Dismiss retires it unnamed.
 */
import { EntityPicker } from "@/components/entity-picker";
import { type WhatsAppContextMessage, type WhatsAppIdentityReviewItem, api } from "@/lib/api";
import { EntityAvatar } from "@/lib/entity-ui";
import { formatRelativeTime } from "@/routes/files/file-list";
import { ArrowsLeftRightIcon, CheckIcon, UserFocusIcon, WhatsappLogoIcon, XIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { cn } from "@sketch/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { EntryList, SectionLabel } from "../entity-drawer/drawer-kit";

export type { WhatsAppGroupSighting, WhatsAppIdentitySuggestion, WhatsAppIdentityReviewItem } from "@/lib/api";

/**
 * Live data source. Only surfaces on person-scoped queues — WhatsApp identities
 * are people. Visibility is server-driven: the endpoint returns only contacts
 * the caller shares a group with, so an admin with no WhatsApp identity, or one
 * who shares no groups, simply gets an empty queue and the band never renders.
 *
 * `resolve` runs after a mutation has already committed. It invalidates both
 * this queue and the sibling entity-review queue, because naming or merging a
 * contact changes what the latter has to say about them too.
 */
export function useWhatsAppIdentityReview(types: string[]): {
  items: WhatsAppIdentityReviewItem[];
  resolve: (id: string, message: string) => void;
} {
  const enabled = types.length === 0 || types.includes("person");
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["whatsapp-identities"],
    queryFn: () => api.entities.whatsappIdentities({ limit: 25 }),
    enabled,
    refetchInterval: 30000,
  });

  const resolve = (_id: string, message: string) => {
    void queryClient.invalidateQueries({ queryKey: ["whatsapp-identities"] });
    void queryClient.invalidateQueries({ queryKey: ["entity-review"] });
    toast.success(message);
  };
  return { items: enabled ? (data?.items ?? []) : [], resolve };
}

function IdentityAvatar({ item, size }: { item: WhatsAppIdentityReviewItem; size: "sm" | "lg" }) {
  if (item.suggestion) {
    return (
      <EntityAvatar entity={{ id: item.entityId, name: item.suggestion.name, sourceType: "person" }} size={size} />
    );
  }
  const dim = size === "lg" ? "h-12 w-12" : "h-6 w-6";
  const icon = size === "lg" ? 20 : 13;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-muted text-muted-foreground",
        dim,
      )}
    >
      <UserFocusIcon size={icon} />
    </span>
  );
}

/**
 * Runs one queue mutation and reports it. `onDone` is only called once the
 * server has accepted the change, so a failure leaves the row in place rather
 * than optimistically dropping something that was never saved.
 */
async function runIdentityAction(action: () => Promise<unknown>, onDone: (message: string) => void, message: string) {
  try {
    await action();
    onDone(message);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not update this contact");
  }
}

/**
 * The conversation around this contact's messages in one group.
 *
 * Their own turns are marked so the eye can follow them through the thread, and
 * everyone else is shown by name — a `known` sender resolves to an entity we
 * already have, an `unknown` one falls back to whatever they call themselves on
 * WhatsApp. The surrounding turns matter more than the contact's own: a name
 * usually shows up because someone else says it.
 *
 * Falls back to the queue's one-line snippet until the fuller context arrives.
 */
function GroupEvidence({
  excerpts,
  fallbackSnippet,
}: {
  excerpts: Array<{ startedAt: string; messages: WhatsAppContextMessage[] }>;
  fallbackSnippet: string | null;
}) {
  if (excerpts.length === 0) {
    return fallbackSnippet ? (
      <p className="mt-1.5 border-l-2 border-border pl-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        {fallbackSnippet}
      </p>
    ) : null;
  }

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {excerpts.map((excerpt) => (
        <div key={excerpt.startedAt} className="border-l-2 border-border pl-2.5">
          {excerpt.messages.map((message) => (
            <p key={message.id} className="text-[11.5px] leading-relaxed">
              <span
                className={cn(
                  "mr-1 font-medium",
                  message.role === "self" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                )}
              >
                {message.role === "self" ? "This contact" : message.senderName || "Unknown"}:
              </span>
              <span className="text-muted-foreground">{message.text}</span>
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

function GroupChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-[12rem] items-center truncate rounded-full border border-border bg-background/40 px-2 py-0.5 text-[10.5px] text-foreground/80">
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * One WhatsApp identity row inside the review queue. Line 1 mirrors the plain
 * review row (avatar · name · muted note · caret · actions) so the whole column
 * aligns; line 2 carries the evidence — a quiet channel glyph, the groups as the
 * recognizable anchor, then the muted phone. The primary action (Merge when we
 * already have an entity to fold this into, otherwise Add) opens the drawer,
 * where the guess is checked against the group history before anything commits.
 */
export function WhatsAppIdentityRow({
  item,
  onOpen,
  onResolve,
}: {
  item: WhatsAppIdentityReviewItem;
  onOpen: () => void;
  onResolve: (message: string) => void;
}) {
  const hasSuggestion = item.suggestion !== null;
  const name = item.suggestion?.name ?? "Unidentified contact";
  const note = hasSuggestion ? `${item.suggestion?.confidence} this person` : "needs a name";
  const primaryLabel = item.suggestion?.entityId ? "Merge" : "Add";
  const shownGroups = item.groups.slice(0, 2);
  const moreGroups = item.groups.length - shownGroups.length;

  return (
    <div className="border-b border-border/60 last:border-b-0" data-testid={`wa-identity-row-${item.id}`}>
      <div className="flex w-full items-start transition-colors hover:bg-foreground/10">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-left">
          <div className="flex w-full items-center gap-2">
            <IdentityAvatar item={item} size="sm" />
            <span
              className={cn(
                "shrink-0 truncate text-[12.5px] font-medium",
                hasSuggestion ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{note}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <WhatsappLogoIcon
              size={13}
              weight="fill"
              aria-label="WhatsApp"
              className="shrink-0 text-muted-foreground"
            />
            {shownGroups.map((group) => (
              <GroupChip key={group.groupJid} name={group.groupName} />
            ))}
            {moreGroups > 0 ? <span className="text-[10.5px] text-muted-foreground">+{moreGroups} more</span> : null}
            {item.phoneE164 ? (
              <span className="ml-1 font-mono text-[10px] tracking-tight text-muted-foreground/70">
                {item.phoneE164}
              </span>
            ) : null}
          </div>
        </button>
        <span className="flex shrink-0 items-center gap-0.5 py-2 pr-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:underline"
          >
            {primaryLabel}
          </button>
          <span className="text-muted-foreground/40">·</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void runIdentityAction(() => api.entities.dismissWhatsAppIdentity(item.entityId), onResolve, "Dismissed");
            }}
            className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * Right-hand identify drawer for one WhatsApp contact. The name/phone/email form
 * leads as the primary action (the contact is unidentified — you're giving them
 * an identity), and the groups it's been seen in follow as the evidence you use
 * to fill it. Merge into an existing person stays a footer action.
 */
export function WhatsAppIdentityDrawer({
  item,
  onClose,
  onResolve,
}: {
  item: WhatsAppIdentityReviewItem | null;
  onClose: () => void;
  onResolve: (id: string, message: string) => void;
}) {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
        <SheetTitle className="sr-only">{item ? "Identify WhatsApp contact" : "Review"}</SheetTitle>
        <SheetDescription className="sr-only">
          Identify an unknown WhatsApp contact from the groups and messages it appears in, then save their details or
          merge them into someone you already know.
        </SheetDescription>
        {item ? (
          <WhatsAppIdentityBody
            key={item.id}
            item={item}
            onResolve={(message) => {
              onResolve(item.id, message);
              onClose();
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function WhatsAppIdentityBody({
  item,
  onResolve,
}: {
  item: WhatsAppIdentityReviewItem;
  onResolve: (message: string) => void;
}) {
  const [name, setName] = useState(item.suggestion?.name ?? "");
  const [phone, setPhone] = useState(item.phoneE164 ?? "");
  const [email, setEmail] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const trimmedName = name.trim();
  const initialName = (item.suggestion?.name ?? "").trim();
  const initialPhone = (item.phoneE164 ?? "").trim();
  const dirty = trimmedName !== initialName || phone.trim() !== initialPhone || email.trim().length > 0;
  const canSave = trimmedName.length > 0 && dirty;
  const hasGuess = item.suggestion !== null;
  const showSuggestionConfirm = hasGuess && !dirty;
  const [busy, setBusy] = useState(false);

  /**
   * The full conversation around this contact's messages, fetched only while the
   * drawer is open. The row and the group list already carry a one-line snippet
   * from the queue payload; this adds the surrounding turns, which is usually
   * where the name actually appears — someone greets them or thanks them by it.
   */
  const { data: context } = useQuery({
    queryKey: ["whatsapp-context", item.entityId],
    queryFn: () => api.entities.whatsappContext(item.entityId, { groups: 5, messagesPerGroup: 30 }),
  });
  const excerptsByGroup = new Map((context?.groups ?? []).map((group) => [group.groupJid, group.excerpts]));

  /**
   * Naming the placeholder is what retires it: the rename flips `name_status`
   * to confirmed server-side, so it drops out of this queue and stops showing a
   * proposed name.
   *
   * The rename goes LAST, deliberately. There is no transaction across these
   * calls, so whichever runs first is the one that survives a failure in the
   * others. Renaming first meant a rejected phone number — a malformed value,
   * or one already held by another entity — left the contact confirmed and
   * gone from the queue while the admin was shown an error and reasonably
   * believed nothing had been saved. With the contact points first, a rejection
   * leaves the entity untouched and the row still there to retry.
   */
  const saveIdentity = async (finalName: string) => {
    const trimmedPhone = phone.trim();
    const trimmedEmail = email.trim();
    if (trimmedPhone && trimmedPhone !== initialPhone) {
      await api.entities.createContactPoint(item.entityId, { kind: "phone", value: trimmedPhone });
    }
    if (trimmedEmail) {
      await api.entities.createContactPoint(item.entityId, { kind: "email", value: trimmedEmail });
    }
    await api.entities.rename(item.entityId, finalName);
  };

  const act = (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    void runIdentityAction(action, onResolve, message).finally(() => setBusy(false));
  };

  const confirmSuggestion = () => {
    const suggestion = item.suggestion;
    if (!suggestion) return;
    act(
      () =>
        suggestion.entityId ? api.entities.merge(suggestion.entityId, item.entityId) : saveIdentity(suggestion.name),
      suggestion.entityId ? `Merged into ${suggestion.name}` : `Saved ${suggestion.name}`,
    );
  };
  const accent = "#f59e0b";
  const helper = item.suggestion
    ? "We've guessed a name below — confirm it, or merge them into someone you already know."
    : "Name this contact from the groups below, or merge them into someone you already know.";

  return (
    <>
      <div
        className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
        style={{ borderTopColor: accent, borderTopWidth: 3 }}
      >
        <div className="flex items-start gap-3">
          <IdentityAvatar item={item} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                Person
              </Badge>
              <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
                <WhatsappLogoIcon size={10} weight="fill" />
                WhatsApp
              </Badge>
              <Badge
                variant="outline"
                className="border-amber-300 text-[10px] uppercase tracking-wider text-amber-700 dark:border-amber-700 dark:text-amber-400"
              >
                Unidentified
              </Badge>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-4">
        <div className="-mx-6 flex flex-col gap-3.5 border-b bg-muted/40 px-6 pb-5 pt-4 dark:bg-muted/20">
          <div className="flex flex-col gap-1.5">
            <SectionLabel className="font-medium">Name</SectionLabel>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Name this contact"
              aria-label="Name"
              className="h-10 bg-background font-serif text-[17px]"
              data-testid="wa-identity-name-input"
            />
            {showSuggestionConfirm ? (
              <button
                type="button"
                onClick={confirmSuggestion}
                className="inline-flex items-center gap-1.5 self-start rounded-full border border-emerald-400/60 bg-emerald-50/60 px-2.5 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100/70 dark:border-emerald-600/50 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
                data-testid="wa-identity-confirm-suggestion"
              >
                <CheckIcon size={11} weight="bold" />
                {item.suggestion?.entityId ? "This is them" : "Use this name"}
              </button>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <SectionLabel className="font-medium">
              Phone <span className="normal-case tracking-normal opacity-70">(optional)</span>
            </SectionLabel>
            <Input
              value={phone}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              inputMode="tel"
              className="bg-background font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <SectionLabel className="font-medium">
              Email <span className="normal-case tracking-normal opacity-70">(optional)</span>
            </SectionLabel>
            <Input
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              placeholder="name@company.com"
              inputMode="email"
              className="bg-background font-mono text-xs"
            />
          </div>
        </div>

        <div className="flex flex-col">
          <SectionLabel className="mb-1.5 font-medium">
            Seen in · {item.groups.length} {item.groups.length === 1 ? "group" : "groups"}
          </SectionLabel>
          <EntryList>
            {item.groups.map((group) => (
              <li key={group.groupJid} className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                    <WhatsappLogoIcon size={9} weight="fill" />
                    Group
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.groupName}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {group.messageCount} msgs · {formatRelativeTime(group.lastMessageAt)}
                  </span>
                </div>
                <GroupEvidence excerpts={excerptsByGroup.get(group.groupJid) ?? []} fallbackSnippet={group.snippet} />
              </li>
            ))}
          </EntryList>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t bg-background px-6 py-3">
        <Button
          size="sm"
          onClick={() => act(() => saveIdentity(trimmedName), `Saved ${trimmedName}`)}
          disabled={!canSave || busy}
          className="h-7 gap-1 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
          data-testid="wa-identity-add"
        >
          <CheckIcon size={12} weight="bold" />
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMergeOpen(true)}
          className="h-7 gap-1 text-[11px]"
          data-testid="wa-identity-merge"
        >
          <ArrowsLeftRightIcon size={12} />
          Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => act(() => api.entities.dismissWhatsAppIdentity(item.entityId), "Dismissed")}
          disabled={busy}
          className="ml-auto h-7 gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="wa-identity-dismiss"
        >
          <XIcon size={12} />
          Dismiss
        </Button>
      </div>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Merge this contact into…</DialogTitle>
            <DialogDescription>
              Pick the person this WhatsApp contact already is. Their number and group history fold into that entity —
              no new person is created.
            </DialogDescription>
          </DialogHeader>
          <EntityPicker
            entityType="person"
            onPick={(entityId) => {
              setMergeOpen(false);
              act(() => api.entities.merge(entityId, item.entityId), "Merged");
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
