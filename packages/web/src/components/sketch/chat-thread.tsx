import { AppIcon } from "@/components/connections/app-icon";
import type { AutomationArtifact } from "@/lib/api";
import {
  BrainIcon,
  CaretDownIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CopySimpleIcon,
  DatabaseIcon,
  FileMagnifyingGlassIcon,
  FileTextIcon,
  GlobeIcon,
  GraduationCapIcon,
  type Icon,
  ImageIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  MicrophoneIcon,
  PaperclipIcon,
  PlugIcon,
  PuzzlePieceIcon,
  SparkleIcon,
  SpinnerGapIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import type { WebChatQuestion, WebChatQuestionOption } from "@sketch/shared";
import { cn } from "@sketch/ui/lib/utils";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AutomationArtifactCard } from "./automation-artifact-card";
import { SketchMessage, UserMessage } from "./chat-message";

export interface ChatThreadFile {
  name: string;
  url: string;
  mediaType?: string;
  sizeBytes?: number;
}

export type ChatThreadIntegrationConnectionStatus =
  | "idle"
  | "loading"
  | "connecting"
  | "connected"
  | "error"
  | "unavailable";

export interface ChatThreadIntegrationConnection {
  requestId: string;
  appId: string;
  appName: string;
  state?: "connect" | "connected";
  icon?: string;
  reason?: string;
  accountName?: string;
  connectionId?: string | null;
}

export type ChatThreadProgressIconType = "tool" | "skill" | "canvas" | "generic";

export interface ChatThreadProgressIcon {
  type: ChatThreadProgressIconType;
  name?: string;
}

export interface ChatThreadProgressItem {
  id?: string;
  kind: string;
  label: string;
  detail?: string;
  toolName?: string;
  icon?: ChatThreadProgressIcon;
}

export interface ChatThreadInterruption {
  label: string;
  detail?: string;
}

export type ChatThreadQuestion = WebChatQuestion;

export type ChatThreadTimelineEntry =
  | { id?: string; type: "text"; text: string }
  | {
      id?: string;
      type: "progress";
      progressItems?: ChatThreadProgressItem[];
      progressLines?: string[];
    };

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  createdAt?: string;
  files?: ChatThreadFile[];
  automations?: AutomationArtifact[];
  integrationConnections?: ChatThreadIntegrationConnection[];
  timeline?: ChatThreadTimelineEntry[];
  progressItems?: ChatThreadProgressItem[];
  progressLines?: string[];
  interruption?: ChatThreadInterruption;
  question?: ChatThreadQuestion;
}

export interface ChatThreadProps {
  messages?: ChatThreadMessage[];
  busy?: boolean;
  error?: string | null;
  className?: string;
  integrationConnectionStatuses?: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  onSelectQuestion?: (question: ChatThreadQuestion, option: WebChatQuestionOption) => void;
  conversationId?: string;
}

const markdownPlugins = [remarkGfm];
const MAX_VISIBLE_TIMELINE_PROGRESS_ENTRIES = 3;
const TIMELINE_WINDOW_ANIMATION_MS = 220;

type ProgressIconComponent = Icon;

interface TimelineRenderEntry {
  key: string;
  entry: ChatThreadTimelineEntry;
}

type TimelineRenderBlock =
  | { type: "text"; key: string; entry: TimelineRenderEntry }
  | { type: "progress"; key: string; entries: TimelineRenderEntry[] };

interface AnimatedTimelineWindowState {
  entries: TimelineRenderEntry[];
  exitingKeys: string[];
  height: number | null;
  offsetY: number;
  animating: boolean;
}

function safeMarkdownHref(href: string | undefined): string | null {
  const value = href?.trim();
  if (!value) return null;
  if (value.startsWith("/") || value.startsWith("#")) return value;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? value : null;
  } catch {
    return null;
  }
}

function isExternalHref(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://");
}

function textFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromReactNode(node.props.children);
  return "";
}

function compactUrlLabel(href: string): string {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    const label = `${host}${path}`;
    if (label.length <= 42) return label;
    return `${label.slice(0, 39)}...`;
  } catch {
    return href.length <= 42 ? href : `${href.slice(0, 39)}...`;
  }
}

function linkChildrenForHref(href: string, children: ReactNode): ReactNode {
  const text = textFromReactNode(children).trim();
  return text === href || text === `<${href}>` ? compactUrlLabel(href) : children;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownLinkHref(href: string): string {
  return href.replaceAll(")", "%29").replaceAll(" ", "%20");
}

function normalizeChatMarkdown(text: string): string {
  return text
    .replace(/<((?:https?:\/\/|mailto:)[^>|]+)\|([^>]+)>/g, (_match, href: string, label: string) => {
      return `[${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkHref(href)})`;
    })
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, (_match, href: string) => href);
}

function copyableMarkdownText(text: string | undefined): string | null {
  const value = normalizeChatMarkdown(text ?? "").trim();
  return value ? value : null;
}

function assistantResponseCopyText(message: ChatThreadMessage): string | null {
  if (message.role !== "assistant") return null;

  const entries = timelineEntriesForMessage(message);
  if (entries.length > 0) {
    const finalEntry = entries.at(-1);
    return finalEntry?.type === "text" ? copyableMarkdownText(finalEntry.text) : null;
  }

  return copyableMarkdownText(message.text);
}

function stripLegacyProgressPrefix(text: string): string {
  let value = text.trim();
  for (let index = 0; index < 3; index += 1) {
    const next = value
      .replace(/^:[a-z0-9_+-]+:\s*/i, "")
      .replace(
        /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}][\u{FE0E}\u{FE0F}]?(?:\u{200D}[\p{Extended_Pictographic}\p{Emoji_Presentation}][\u{FE0E}\u{FE0F}]?)*\s*)+/u,
        "",
      )
      .trimStart();
    if (next === value) return value.trim();
    value = next;
  }
  return value.trim();
}

function normalizeProgressText(text: string | undefined): string {
  return stripLegacyProgressPrefix(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function legacyProgressKind(label: string): string {
  const normalized = label.toLowerCase();
  if (/\b(search|find|grep|rg|lookup|query)\b/.test(normalized)) return "search";
  if (/\b(read|write|edit|open|file|load|save|attach|upload|download)\b/.test(normalized)) return "file";
  if (/\b(run|bash|shell|command|tool)\b/.test(normalized)) return "tool";
  if (/\b(app|api|connect|fetch|web|http|url)\b/.test(normalized)) return "app";
  return "generic";
}

function normalizedProgressItem(item: ChatThreadProgressItem): ChatThreadProgressItem | null {
  const label = normalizeProgressText(item.label);
  const detail = normalizeProgressText(item.detail);
  const toolName = normalizeProgressText(item.toolName);
  const kind = normalizeProgressText(item.kind) || "generic";
  if (!label && !detail) return null;

  return {
    ...item,
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined,
    kind,
    label: label || detail,
    detail: label && detail ? detail : undefined,
    toolName: toolName || undefined,
    icon: item.icon,
  };
}

function legacyProgressItem(line: string, index: number): ChatThreadProgressItem | null {
  const label = normalizeProgressText(line);
  if (!label) return null;
  return { id: `legacy-${index}`, kind: legacyProgressKind(label), label };
}

function progressItemsForParts(
  progressItems?: ChatThreadProgressItem[],
  progressLines?: string[],
): ChatThreadProgressItem[] {
  const structured = (progressItems ?? [])
    .map((item) => normalizedProgressItem(item))
    .filter((item): item is ChatThreadProgressItem => Boolean(item));
  if (structured.length > 0) return structured;
  return (progressLines ?? [])
    .map((line, index) => legacyProgressItem(line, index))
    .filter((item): item is ChatThreadProgressItem => Boolean(item));
}

function progressItemsForMessage(message: ChatThreadMessage): ChatThreadProgressItem[] {
  return progressItemsForParts(message.progressItems, message.progressLines);
}

function normalizedTimelineEntry(entry: ChatThreadTimelineEntry): ChatThreadTimelineEntry | null {
  const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : undefined;
  if (entry.type === "text") {
    const text = entry.text.trim();
    return text ? { id, type: "text", text } : null;
  }

  const progressItems = progressItemsForParts(entry.progressItems, entry.progressLines);
  return progressItems.length > 0 ? { id, type: "progress", progressItems } : null;
}

function timelineEntriesForMessage(message: ChatThreadMessage): ChatThreadTimelineEntry[] {
  const timeline = (message.timeline ?? [])
    .map((entry) => normalizedTimelineEntry(entry))
    .filter((entry): entry is ChatThreadTimelineEntry => Boolean(entry));
  if (timeline.length > 0) return timeline;

  const progressItems = progressItemsForMessage(message);
  return progressItems.length > 0 ? [{ type: "progress", progressItems }] : [];
}

function hasTimeline(message: ChatThreadMessage): boolean {
  return timelineEntriesForMessage(message).length > 0;
}

function progressItemKey(item: ChatThreadProgressItem, index: number): string {
  return item.id ?? `${item.kind}:${item.label}:${item.detail ?? ""}:${item.toolName ?? ""}:${index}`;
}

function progressItemsSignature(items: ChatThreadProgressItem[]): string {
  return items.map((item, index) => progressItemKey(item, index)).join("|");
}

function timelineEntryKey(entry: ChatThreadTimelineEntry, index: number): string {
  if (entry.id) return entry.id;
  if (entry.type === "text") return `text:${index}`;
  return `progress:${progressItemsSignature(progressItemsForParts(entry.progressItems, entry.progressLines))}:${index}`;
}

function timelineEntryContentSignature(entry: ChatThreadTimelineEntry): string {
  if (entry.type === "text") return `text:${entry.text}`;
  return `progress:${progressItemsSignature(progressItemsForParts(entry.progressItems, entry.progressLines))}`;
}

function timelineRenderEntriesForMessage(message: ChatThreadMessage): TimelineRenderEntry[] {
  return timelineEntriesForMessage(message).map((entry, index) => ({ key: timelineEntryKey(entry, index), entry }));
}

function timelineRenderEntriesSignature(entries: TimelineRenderEntry[]): string {
  return entries.map((entry) => `${entry.key}:${timelineEntryContentSignature(entry.entry)}`).join("\u001f");
}

function timelineRenderBlocksForEntries(entries: TimelineRenderEntry[]): TimelineRenderBlock[] {
  const blocks: TimelineRenderBlock[] = [];
  let progressEntries: TimelineRenderEntry[] = [];
  let progressBlockIndex = 0;

  const flushProgressEntries = () => {
    if (progressEntries.length === 0) return;
    blocks.push({
      type: "progress",
      key: `progress-block-${progressBlockIndex}:${progressEntries[0].key}`,
      entries: progressEntries,
    });
    progressBlockIndex += 1;
    progressEntries = [];
  };

  for (const entry of entries) {
    if (entry.entry.type === "progress") {
      progressEntries.push(entry);
      continue;
    }

    flushProgressEntries();
    blocks.push({ type: "text", key: entry.key, entry });
  }

  flushProgressEntries();
  return blocks;
}

function latestActiveProgressEntryKey(blocks: TimelineRenderBlock[]): string | undefined {
  const latestBlock = blocks.at(-1);
  if (latestBlock?.type !== "progress") return undefined;
  return latestBlock.entries.at(-1)?.key;
}

function shouldCollapseProgressBlocks(blocks: TimelineRenderBlock[], active: boolean): boolean {
  if (!blocks.some((block) => block.type === "progress")) return false;
  if (!active) return true;
  return blocks.at(-1)?.type === "text";
}

function visibleProgressRenderEntries(entries: TimelineRenderEntry[]): TimelineRenderEntry[] {
  if (entries.length <= MAX_VISIBLE_TIMELINE_PROGRESS_ENTRIES) return entries;

  for (const entry of entries) {
    if (entry.entry.type !== "progress") return entries;
  }

  return entries.slice(-MAX_VISIBLE_TIMELINE_PROGRESS_ENTRIES);
}

function timelineWindowOverlap(previous: TimelineRenderEntry[], next: TimelineRenderEntry[]): number {
  const maxLength = Math.min(previous.length, next.length);
  for (let length = maxLength; length > 0; length -= 1) {
    const previousStart = previous.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (previous[previousStart + index].key !== next[index].key) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function prefersReducedTimelineMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function progressIconTokens(item: ChatThreadProgressItem): string[] {
  return [item.icon?.name, item.toolName, item.kind, item.label]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.toLowerCase());
}

function hasProgressToken(item: ChatThreadProgressItem, pattern: RegExp): boolean {
  return progressIconTokens(item).some((token) => pattern.test(token));
}

const PROGRESS_KIND_ICONS: Record<string, ProgressIconComponent> = {
  reasoning: BrainIcon,
  file: FileMagnifyingGlassIcon,
  search: MagnifyingGlassIcon,
  shell: TerminalWindowIcon,
  local: TerminalWindowIcon,
  web: GlobeIcon,
  canvas: PuzzlePieceIcon,
  integration: PuzzlePieceIcon,
  skill: GraduationCapIcon,
  attachment: PaperclipIcon,
  audio: MicrophoneIcon,
  image: ImageIcon,
  schedule: ClockIcon,
  entity: DatabaseIcon,
  delivery: MapPinIcon,
  chat: ChatCircleIcon,
  tool: WrenchIcon,
};

function progressIconForItem(item: ChatThreadProgressItem): ProgressIconComponent {
  const byKind = PROGRESS_KIND_ICONS[item.kind.toLowerCase()];
  if (byKind) return byKind;

  if (hasProgressToken(item, /\b(bash|shell|terminal|command|exec)\b/)) return TerminalWindowIcon;
  if (hasProgressToken(item, /\b(search|find|grep|rg|lookup|query)\b/)) return MagnifyingGlassIcon;
  if (hasProgressToken(item, /\b(read|open|inspect|file|load|save|write|edit|attach|upload|download)\b/)) {
    return FileMagnifyingGlassIcon;
  }
  if (hasProgressToken(item, /\b(web|http|url|fetch|browser|request|app|api|connect)\b/)) return GlobeIcon;

  switch (item.icon?.type) {
    case "tool":
      return WrenchIcon;
    case "skill":
      return GraduationCapIcon;
    case "canvas":
      return PuzzlePieceIcon;
    default:
      return SparkleIcon;
  }
}

const markdownComponents: Components = {
  a({ href, children }) {
    const safeHref = safeMarkdownHref(href);
    if (!safeHref) return <span>{children}</span>;
    const external = isExternalHref(safeHref);

    return (
      <a href={safeHref} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>
        {linkChildrenForHref(safeHref, children)}
      </a>
    );
  },
};

const markdownComponentsWithCopy: Components = {
  ...markdownComponents,
  p({ children }) {
    return <MarkdownParagraph>{children}</MarkdownParagraph>;
  },
  pre({ children }) {
    return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
  },
  code({ className, children }) {
    return <code className={className}>{children}</code>;
  },
};

function emptyAnimatedTimelineState(entries: TimelineRenderEntry[]): AnimatedTimelineWindowState {
  return {
    entries,
    exitingKeys: [],
    height: null,
    offsetY: 0,
    animating: false,
  };
}

function useAnimatedTimelineWindow(targetEntries: TimelineRenderEntry[]) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const frameRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const latestTargetEntries = useRef(targetEntries);
  const [state, setState] = useState<AnimatedTimelineWindowState>(() => emptyAnimatedTimelineState(targetEntries));
  const stateRef = useRef(state);
  const targetSignature = timelineRenderEntriesSignature(targetEntries);

  latestTargetEntries.current = targetEntries;

  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  useLayoutEffect(() => {
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const targetEntries = latestTargetEntries.current;
    const current = stateRef.current;
    if (timelineRenderEntriesSignature(current.entries) === targetSignature && !current.animating) return;

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (current.animating || prefersReducedTimelineMotion()) {
      setState(emptyAnimatedTimelineState(targetEntries));
      return;
    }

    const overlap = timelineWindowOverlap(current.entries, targetEntries);
    const removedCount = current.entries.length - overlap;
    const appendedEntries = targetEntries.slice(overlap);
    if (overlap === 0 || removedCount <= 0 || appendedEntries.length === 0) {
      setState(emptyAnimatedTimelineState(targetEntries));
      return;
    }

    const viewport = viewportRef.current;
    const track = trackRef.current;
    const firstRemoved = rowRefs.current.get(current.entries[0]?.key ?? "");
    const firstKept = rowRefs.current.get(current.entries[removedCount]?.key ?? "");
    const currentHeight = viewport?.getBoundingClientRect().height ?? 0;
    const removedHeight =
      firstRemoved && firstKept ? firstKept.getBoundingClientRect().top - firstRemoved.getBoundingClientRect().top : 0;

    if (!viewport || !track || currentHeight <= 0 || removedHeight <= 0) {
      setState(emptyAnimatedTimelineState(targetEntries));
      return;
    }

    const combinedEntries = [...current.entries, ...appendedEntries];
    setState({
      entries: combinedEntries,
      exitingKeys: current.entries.slice(0, removedCount).map((entry) => entry.key),
      height: currentHeight,
      offsetY: 0,
      animating: false,
    });

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const nextTrack = trackRef.current;
      const targetHeight = nextTrack ? Math.max(0, nextTrack.scrollHeight - removedHeight) : currentHeight;
      setState({
        entries: combinedEntries,
        exitingKeys: current.entries.slice(0, removedCount).map((entry) => entry.key),
        height: targetHeight,
        offsetY: -removedHeight,
        animating: true,
      });
    });

    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setState(emptyAnimatedTimelineState(latestTargetEntries.current));
    }, TIMELINE_WINDOW_ANIMATION_MS);
  }, [targetSignature]);

  const setRowRef = (key: string) => (node: HTMLDivElement | null) => {
    if (node) {
      rowRefs.current.set(key, node);
    } else {
      rowRefs.current.delete(key);
    }
  };

  return {
    entries: state.entries,
    exitingKeys: state.exitingKeys,
    viewportRef,
    trackRef,
    setRowRef,
    viewportStyle: {
      height: state.height === null ? undefined : `${state.height}px`,
    } satisfies CSSProperties,
    trackStyle: {
      transform: state.offsetY === 0 ? undefined : `translateY(${state.offsetY}px)`,
    } satisfies CSSProperties,
    animating: state.animating,
  };
}

export function ChatThread({
  messages = [],
  busy = false,
  error,
  className,
  integrationConnectionStatuses = {},
  onConnectIntegration,
  onSelectQuestion,
  conversationId,
}: ChatThreadProps) {
  if (messages.length === 0 && !busy && !error) return null;
  const showBusy = busy && messages.at(-1)?.role !== "assistant";
  const activeQuestionMessageId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.question)?.id;

  return (
    <section aria-label="Chat thread" className={cn("flex flex-col gap-[24px]", className)}>
      {messages.map((message, index) => (
        <MessageRow
          key={message.id}
          message={message}
          active={busy && index === messages.length - 1}
          integrationConnectionStatuses={integrationConnectionStatuses}
          onConnectIntegration={onConnectIntegration}
          onSelectQuestion={onSelectQuestion}
          questionAnswerable={message.id === activeQuestionMessageId && !busy}
          conversationId={conversationId}
        />
      ))}

      {showBusy ? (
        <SketchMessage streaming>
          <span className="sketch-shimmer-text text-[13px] font-medium">Thinking…</span>
        </SketchMessage>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-[14px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}

function MessageRow({
  message,
  active,
  integrationConnectionStatuses,
  onConnectIntegration,
  onSelectQuestion,
  questionAnswerable,
  conversationId,
}: {
  message: ChatThreadMessage;
  active: boolean;
  integrationConnectionStatuses: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  onSelectQuestion?: (question: ChatThreadQuestion, option: WebChatQuestionOption) => void;
  questionAnswerable: boolean;
  conversationId?: string;
}) {
  if (message.role === "user") {
    return (
      <UserMessage footer={<MessageTimestamp createdAt={message.createdAt} align="right" />}>
        <MessageContent message={message} conversationId={conversationId} />
      </UserMessage>
    );
  }

  const assistantMessage = hasTimeline(message) ? (
    <SketchMessage streaming={active} footer={<AssistantMessageFooter message={message} active={active} />}>
      <TimelineMessage
        message={message}
        active={active}
        integrationConnectionStatuses={integrationConnectionStatuses}
        onConnectIntegration={onConnectIntegration}
        conversationId={conversationId}
      />
      {message.question ? (
        <QuestionCard question={message.question} disabled={!questionAnswerable} onSelect={onSelectQuestion} />
      ) : null}
    </SketchMessage>
  ) : message.text ||
    message.files?.length ||
    message.automations?.length ||
    message.integrationConnections?.length ||
    message.question ? (
    <SketchMessage streaming={active} footer={<AssistantMessageFooter message={message} active={active} />}>
      <MessageContent
        message={message}
        inProgress={active}
        integrationConnectionStatuses={integrationConnectionStatuses}
        onConnectIntegration={onConnectIntegration}
        onSelectQuestion={onSelectQuestion}
        questionAnswerable={questionAnswerable}
        conversationId={conversationId}
      />
    </SketchMessage>
  ) : null;

  if (message.interruption) {
    return (
      <>
        {assistantMessage}
        <InterruptionNotice interruption={message.interruption} />
      </>
    );
  }

  if (hasTimeline(message)) {
    return assistantMessage;
  }

  return assistantMessage;
}

function InterruptionNotice({ interruption }: { interruption: ChatThreadInterruption }) {
  return (
    <output data-interruption-notice className="ml-[36px] max-w-[720px] border-l-2 border-border/80 py-[2px] pl-[12px]">
      {interruption.detail ? (
        <div className="text-[12px] font-medium leading-[1.45] text-muted-foreground/70">{interruption.detail}</div>
      ) : null}
      <div className="text-[13px] font-medium leading-[1.5] text-foreground/80">{interruption.label}</div>
    </output>
  );
}

function formatMessageTime(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function AssistantMessageFooter({ message, active }: { message: ChatThreadMessage; active: boolean }) {
  const copyText = active ? null : assistantResponseCopyText(message);
  if (!message.createdAt && !copyText) return null;

  return (
    <div className="mt-[5px] flex min-h-[24px] items-center gap-[6px]">
      <MessageTimestamp createdAt={message.createdAt} align="left" className="mt-0" />
      {copyText ? <CopyIconButton text={copyText} label="Copy response" copiedLabel="Response copied" /> : null}
    </div>
  );
}

function MessageTimestamp({
  createdAt,
  align,
  className,
}: {
  createdAt?: string;
  align: "left" | "right";
  className?: string;
}) {
  if (!createdAt) return null;
  const label = formatMessageTime(createdAt);
  if (!label) return null;

  return (
    <time
      dateTime={createdAt}
      className={cn(
        "mt-[5px] block text-[11px] leading-none text-muted-foreground/65",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {label}
    </time>
  );
}

function MessageContent({
  message,
  inProgress = false,
  integrationConnectionStatuses = {},
  onConnectIntegration,
  onSelectQuestion,
  questionAnswerable = false,
  conversationId,
}: {
  message: ChatThreadMessage;
  inProgress?: boolean;
  integrationConnectionStatuses?: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  onSelectQuestion?: (question: ChatThreadQuestion, option: WebChatQuestionOption) => void;
  questionAnswerable?: boolean;
  conversationId?: string;
}) {
  const copyBlocks = message.role === "assistant";
  const hasConnections = Boolean(message.integrationConnections?.length);
  const hasAutomations = Boolean(message.automations?.length);
  const hasQuestion = Boolean(message.question);
  if (!message.files?.length && !hasAutomations && !hasConnections && !hasQuestion) {
    return message.text ? (
      <MarkdownMessage text={message.text} inProgress={inProgress} copyBlocks={copyBlocks} />
    ) : null;
  }

  return (
    <div className="min-w-0 space-y-[10px]">
      {message.text ? <MarkdownMessage text={message.text} inProgress={inProgress} copyBlocks={copyBlocks} /> : null}
      {message.files?.length ? <FileAttachments files={message.files} /> : null}
      {message.automations?.length ? (
        <AutomationArtifactCards automations={message.automations} conversationId={conversationId} />
      ) : null}
      {message.integrationConnections?.length ? (
        <IntegrationConnectionCards
          connections={message.integrationConnections}
          statuses={integrationConnectionStatuses}
          onConnect={onConnectIntegration}
        />
      ) : null}
      {message.question ? (
        <QuestionCard question={message.question} disabled={!questionAnswerable} onSelect={onSelectQuestion} />
      ) : null}
    </div>
  );
}

function QuestionCard({
  question,
  disabled,
  onSelect,
}: {
  question: ChatThreadQuestion;
  disabled: boolean;
  onSelect?: (question: ChatThreadQuestion, option: WebChatQuestionOption) => void;
}) {
  return (
    <fieldset
      data-question-card
      data-question-id={question.id}
      disabled={disabled}
      className="w-full max-w-[640px] rounded-[12px] border border-brand-accent/35 bg-brand-accent/[0.045] p-3"
    >
      <legend className="px-1 text-[13px] font-semibold leading-5 text-foreground">{question.prompt}</legend>
      <div className="mt-2 grid gap-2">
        {question.options.map((option) => (
          <button
            key={option.id}
            type="button"
            data-question-option-id={option.id}
            className="rounded-[9px] border border-border/80 bg-background/70 px-3 py-2 text-left transition hover:border-brand-accent/60 hover:bg-brand-accent/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55 disabled:cursor-not-allowed disabled:opacity-55"
            disabled={disabled || !onSelect}
            onClick={() => onSelect?.(question, option)}
          >
            <span className="block text-[13px] font-medium text-foreground">{option.label}</span>
            {option.description ? (
              <span className="mt-0.5 block text-[12px] leading-4 text-muted-foreground">{option.description}</span>
            ) : null}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function AutomationArtifactCards({
  automations,
  conversationId,
}: {
  automations: AutomationArtifact[];
  conversationId?: string;
}) {
  return (
    <div className="flex max-w-[640px] flex-col gap-[8px]">
      {automations.map((artifact) => (
        <AutomationArtifactCard
          key={artifact.taskId}
          artifact={artifact}
          conversationId={conversationId}
          className="mt-0 max-w-none"
        />
      ))}
    </div>
  );
}

function FileAttachments({ files }: { files: ChatThreadFile[] }) {
  return (
    <div className="flex flex-wrap gap-[8px]">
      {files.map((file) => (
        <a
          key={`${file.url}:${file.name}`}
          href={file.url}
          download={file.name}
          className={cn(
            "inline-flex max-w-full items-center gap-[8px] rounded-[8px] border border-border",
            "bg-background/70 px-[10px] py-[8px] text-[13px] text-foreground/90 transition-colors",
            "hover:border-foreground/25 hover:bg-muted/70",
          )}
        >
          <FileTextIcon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{file.name}</span>
        </a>
      ))}
    </div>
  );
}

function IntegrationConnectionCards({
  connections,
  statuses,
  onConnect,
}: {
  connections: ChatThreadIntegrationConnection[];
  statuses: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnect?: (connection: ChatThreadIntegrationConnection) => void;
}) {
  return (
    <div className="flex max-w-[640px] flex-col gap-[8px]">
      {connections.map((connection) => (
        <IntegrationConnectionCard
          key={connection.requestId}
          connection={connection}
          status={statuses[connection.requestId] ?? "idle"}
          onConnect={onConnect}
        />
      ))}
    </div>
  );
}

function IntegrationConnectionAppIcon({ connection }: { connection: ChatThreadIntegrationConnection }) {
  return (
    <AppIcon
      name={connection.appName}
      icon={connection.icon}
      className="size-10 rounded-[8px] bg-transparent text-[12px]"
      imageClassName="size-8"
    />
  );
}

function IntegrationConnectionCard({
  connection,
  status,
  onConnect,
}: {
  connection: ChatThreadIntegrationConnection;
  status: ChatThreadIntegrationConnectionStatus;
  onConnect?: (connection: ChatThreadIntegrationConnection) => void;
}) {
  const effectiveStatus = connection.state === "connected" && status === "idle" ? "connected" : status;
  const state = integrationConnectionState(effectiveStatus);
  const connectedState = effectiveStatus === "connected";
  const disabled =
    effectiveStatus === "loading" ||
    effectiveStatus === "connecting" ||
    connectedState ||
    effectiveStatus === "unavailable" ||
    !onConnect;
  const StatusIcon = state.icon;
  const title = connectedState ? `${connection.appName} connected` : `Connect ${connection.appName}`;
  const description = connectedState
    ? connection.accountName
      ? `${connection.accountName} is connected and available to Sketch.`
      : "This account is connected and available to Sketch."
    : connection.reason || "Connect this app to let Sketch work with it.";

  return (
    <div
      data-integration-connection-card
      className={cn(
        "rounded-[10px] border bg-card px-[14px] py-[12px]",
        connectedState ? "border-success/30 bg-success/5" : "border-border",
      )}
    >
      <div className="flex min-w-0 items-start gap-[12px]">
        <IntegrationConnectionAppIcon connection={connection} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-[7px]">
            <p className="truncate text-[14px] font-semibold leading-[1.4] text-foreground">{title}</p>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-[4px] rounded-[5px] px-[6px] py-[2px] text-[11px] font-medium",
                state.badgeClassName,
              )}
            >
              <StatusIcon
                size={12}
                className={cn((effectiveStatus === "loading" || effectiveStatus === "connecting") && "animate-spin")}
                aria-hidden
              />
              {state.label}
            </span>
          </div>
          <p className="mt-[3px] text-[12px] leading-[1.5] text-muted-foreground">{description}</p>
        </div>
        <button
          type="button"
          className={cn(
            "inline-flex h-[32px] shrink-0 cursor-pointer items-center gap-[6px] rounded-[7px] px-[10px]",
            "text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
            disabled
              ? "cursor-default bg-muted text-muted-foreground"
              : "bg-foreground text-background hover:bg-foreground/90",
          )}
          disabled={disabled}
          onClick={() => onConnect?.(connection)}
        >
          {effectiveStatus === "loading" || effectiveStatus === "connecting" ? (
            <SpinnerGapIcon size={14} className="animate-spin" />
          ) : connectedState ? (
            <CheckCircleIcon size={14} />
          ) : (
            <PlugIcon size={14} />
          )}
          {state.buttonLabel}
        </button>
      </div>
    </div>
  );
}

function integrationConnectionState(status: ChatThreadIntegrationConnectionStatus): {
  label: string;
  buttonLabel: string;
  icon: ProgressIconComponent;
  badgeClassName: string;
} {
  switch (status) {
    case "loading":
      return {
        label: "Checking",
        buttonLabel: "Connect",
        icon: SpinnerGapIcon,
        badgeClassName: "bg-muted text-muted-foreground",
      };
    case "connecting":
      return {
        label: "In progress",
        buttonLabel: "Connecting",
        icon: SpinnerGapIcon,
        badgeClassName: "bg-brand-accent/15 text-[#5A4F00]",
      };
    case "connected":
      return {
        label: "Connected",
        buttonLabel: "Connected",
        icon: CheckCircleIcon,
        badgeClassName: "bg-success/10 text-success",
      };
    case "error":
      return {
        label: "Needs retry",
        buttonLabel: "Retry",
        icon: WarningCircleIcon,
        badgeClassName: "bg-destructive/10 text-destructive",
      };
    case "unavailable":
      return {
        label: "Unavailable",
        buttonLabel: "Unavailable",
        icon: WarningCircleIcon,
        badgeClassName: "bg-muted text-muted-foreground",
      };
    default:
      return {
        label: "Ready",
        buttonLabel: "Connect",
        icon: PlugIcon,
        badgeClassName: "bg-muted text-muted-foreground",
      };
  }
}

function TimelineMessage({
  message,
  active,
  integrationConnectionStatuses = {},
  onConnectIntegration,
  conversationId,
}: {
  message: ChatThreadMessage;
  active: boolean;
  integrationConnectionStatuses?: Record<string, ChatThreadIntegrationConnectionStatus>;
  onConnectIntegration?: (connection: ChatThreadIntegrationConnection) => void;
  conversationId?: string;
}) {
  const entries = useMemo(() => timelineRenderEntriesForMessage(message), [message]);
  const blocks = useMemo(() => timelineRenderBlocksForEntries(entries), [entries]);
  const collapseProgress = shouldCollapseProgressBlocks(blocks, active);
  const activeProgressEntryKey = active ? latestActiveProgressEntryKey(blocks) : undefined;
  const completedSegments = useMemo(() => completedTimelineSegments(entries), [entries]);

  if (!active) {
    return (
      <div className="max-w-[720px]">
        {completedSegments.activityEntries.length > 0 ? (
          <CollapsibleTimelineHistory entries={completedSegments.activityEntries} />
        ) : null}
        {completedSegments.finalEntry?.entry.type === "text" ? (
          <div className={cn(completedSegments.activityEntries.length > 0 && "pt-[2px]")}>
            <MarkdownMessage text={completedSegments.finalEntry.entry.text} copyBlocks />
          </div>
        ) : null}
        {message.files?.length ? (
          <div className="mt-[10px]">
            <FileAttachments files={message.files} />
          </div>
        ) : null}
        {message.automations?.length ? (
          <div className="mt-[10px]">
            <AutomationArtifactCards automations={message.automations} conversationId={conversationId} />
          </div>
        ) : null}
        {message.integrationConnections?.length ? (
          <div className="mt-[10px]">
            <IntegrationConnectionCards
              connections={message.integrationConnections}
              statuses={integrationConnectionStatuses}
              onConnect={onConnectIntegration}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="max-w-[720px]">
      {blocks.map((block) =>
        block.type === "text" ? (
          <TimelineEntryRow key={block.key} entry={block.entry.entry} active={false} exiting={false} last />
        ) : collapseProgress ? (
          <CollapsibleTimelineHistory key={block.key} entries={block.entries} />
        ) : (
          <ProgressTimelineWindow key={block.key} entries={block.entries} activeEntryKey={activeProgressEntryKey} />
        ),
      )}
      {message.files?.length ? (
        <div className="mt-[10px] pl-[30px]">
          <FileAttachments files={message.files} />
        </div>
      ) : null}
      {message.automations?.length ? (
        <div className="mt-[10px] pl-[30px]">
          <AutomationArtifactCards automations={message.automations} conversationId={conversationId} />
        </div>
      ) : null}
      {message.integrationConnections?.length ? (
        <div className="mt-[10px] pl-[30px]">
          <IntegrationConnectionCards
            connections={message.integrationConnections}
            statuses={integrationConnectionStatuses}
            onConnect={onConnectIntegration}
          />
        </div>
      ) : null}
    </div>
  );
}

function progressEntryItemCount(entries: TimelineRenderEntry[]): number {
  return entries.reduce((count, entry) => {
    if (entry.entry.type !== "progress") return count;
    return count + progressItemsForParts(entry.entry.progressItems, entry.entry.progressLines).length;
  }, 0);
}

function textTimelineEntryCount(entries: TimelineRenderEntry[]): number {
  return entries.filter((entry) => entry.entry.type === "text").length;
}

function timelineHistoryCountLabel(entries: TimelineRenderEntry[]): string {
  const toolCallCount = progressEntryItemCount(entries);
  const updateCount = textTimelineEntryCount(entries);
  const parts: string[] = [];

  if (toolCallCount > 0) parts.push(toolCallCount === 1 ? "1 tool call" : `${toolCallCount} tool calls`);
  if (updateCount > 0) parts.push(updateCount === 1 ? "1 update" : `${updateCount} updates`);
  return parts.length > 0 ? parts.join(", ") : "Timeline history";
}

function completedTimelineSegments(entries: TimelineRenderEntry[]): {
  activityEntries: TimelineRenderEntry[];
  finalEntry?: TimelineRenderEntry;
} {
  const finalEntry = entries.at(-1);
  if (finalEntry?.entry.type === "text" && entries.slice(0, -1).some((entry) => entry.entry.type === "progress")) {
    return { activityEntries: entries.slice(0, -1), finalEntry };
  }
  return { activityEntries: entries };
}

function CollapsibleTimelineHistory({ entries }: { entries: TimelineRenderEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const countLabel = timelineHistoryCountLabel(entries);

  return (
    <CollapsiblePrimitive.Root open={expanded} onOpenChange={setExpanded} className="pb-[10px] last:pb-0">
      <CollapsiblePrimitive.Trigger asChild>
        <button
          type="button"
          aria-expanded={expanded}
          data-timeline-summary
          className={cn(
            "group grid w-full cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-[10px]",
            "rounded-[8px] py-[3px] text-left transition-colors duration-150 ease-out hover:bg-muted/35",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
          )}
        >
          <span className="relative z-[1] flex size-[20px] shrink-0 items-center justify-center rounded-[6px] bg-muted/60 text-muted-foreground/90">
            <ClockIcon size={13} weight="duotone" className="shrink-0" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium leading-[1.5] text-foreground/80">Activity timeline</span>
            <span className="block text-[12px] leading-[1.4] text-muted-foreground/65">{countLabel}</span>
          </span>
          <CaretDownIcon
            size={14}
            className={cn(
              "mr-[4px] shrink-0 text-muted-foreground/70 transition-transform duration-150 ease-out",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="sketch-collapsible-timeline-content">
        <div data-timeline-history className="chat-scrollbar max-h-[260px] overflow-y-auto pt-[8px] pr-[4px] pl-[30px]">
          {entries.map((renderEntry, index) => (
            <TimelineEntryRow
              key={renderEntry.key}
              entry={renderEntry.entry}
              active={false}
              exiting={false}
              last={index === entries.length - 1}
            />
          ))}
        </div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

function ProgressTimelineWindow({
  entries,
  activeEntryKey,
}: {
  entries: TimelineRenderEntry[];
  activeEntryKey?: string;
}) {
  const targetEntries = useMemo(() => visibleProgressRenderEntries(entries), [entries]);
  const timelineWindow = useAnimatedTimelineWindow(targetEntries);
  const exitingKeySet = useMemo(() => new Set(timelineWindow.exitingKeys), [timelineWindow.exitingKeys]);

  return (
    <div className="pb-[10px] last:pb-0">
      <div
        ref={timelineWindow.viewportRef}
        aria-live="polite"
        className="sketch-timeline-window overflow-hidden"
        style={timelineWindow.viewportStyle}
      >
        <div
          ref={timelineWindow.trackRef}
          className={cn("flex flex-col", timelineWindow.animating && "sketch-timeline-window-track")}
          style={timelineWindow.trackStyle}
        >
          {timelineWindow.entries.map((renderEntry, index) => (
            <TimelineEntryRow
              key={renderEntry.key}
              rowRef={timelineWindow.setRowRef(renderEntry.key)}
              entry={renderEntry.entry}
              active={renderEntry.key === activeEntryKey}
              exiting={exitingKeySet.has(renderEntry.key)}
              last={index === timelineWindow.entries.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TimelineEntryRow({
  entry,
  active,
  exiting,
  last,
  rowRef,
}: {
  entry: ChatThreadTimelineEntry;
  active: boolean;
  exiting: boolean;
  last: boolean;
  rowRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={rowRef}
      data-timeline-entry
      className={cn(
        "sketch-progress-change sketch-timeline-entry relative grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-x-[10px] pb-[10px] last:pb-0",
        exiting && "sketch-timeline-entry-exiting",
      )}
    >
      {last ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute top-[23px] bottom-[-1px] left-[10px] w-px bg-border/80"
        />
      )}
      {entry.type === "text" ? (
        <TextTimelineEntry entry={entry} />
      ) : (
        <ProgressTimelineEntry
          items={progressItemsForParts(entry.progressItems, entry.progressLines)}
          active={active}
        />
      )}
    </div>
  );
}

function TextTimelineEntry({ entry }: { entry: Extract<ChatThreadTimelineEntry, { type: "text" }> }) {
  return (
    <>
      <span className="relative z-[1] mt-[4px] flex size-[20px] shrink-0 items-center justify-center">
        <span className="block size-[6px] rounded-full bg-muted-foreground/45" />
      </span>
      <div className="min-w-0 pt-[1px]">
        <MarkdownMessage text={entry.text} copyBlocks />
      </div>
    </>
  );
}

function ProgressTimelineEntry({ items, active }: { items: ChatThreadProgressItem[]; active: boolean }) {
  const iconItem = items[0];
  if (!iconItem) return null;

  return (
    <>
      <span className="relative z-[1] flex size-[20px] shrink-0 items-center justify-center rounded-[6px] bg-muted/60 text-muted-foreground/90">
        <ProgressItemIcon item={iconItem} />
      </span>
      <div className="min-w-0">
        {items.map((item, index) => (
          <ProgressItemSummary key={progressItemKey(item, index)} item={item} active={active} />
        ))}
      </div>
    </>
  );
}

function ProgressItemSummary({ item, active }: { item: ChatThreadProgressItem; active: boolean }) {
  const secondary = item.detail;

  return (
    <div data-progress-item className="flex min-w-0 py-[1px]">
      <span
        data-progress-line
        className={cn("inline-flex min-w-0 max-w-full items-baseline gap-x-[8px]", active && "sketch-shimmer-progress")}
      >
        <span className={cn("shrink-0 text-[13px] font-medium leading-[1.5]", !active && "text-foreground/80")}>
          {item.label}
        </span>
        {secondary ? (
          <span className={cn("min-w-0 truncate text-[12px] leading-[1.5]", !active && "text-muted-foreground/65")}>
            {secondary}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function ProgressItemIcon({ item }: { item: ChatThreadProgressItem }) {
  const Icon = progressIconForItem(item);
  return <Icon size={13} weight="duotone" className="shrink-0" aria-hidden />;
}

function copyableCodeText(children: ReactNode): string | null {
  const value = textFromReactNode(children).replace(/\n$/, "");
  return value ? value : null;
}

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {}

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("Copy command failed");
  } finally {
    document.body.removeChild(textarea);
  }
}

function CopyIconButton({
  text,
  label,
  copiedLabel,
  className,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await copyTextToClipboard(text);
      setCopied(true);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : label}
      title={copied ? "Copied" : label}
      className={cn(
        "inline-flex size-[24px] shrink-0 items-center justify-center rounded-[6px]",
        "text-muted-foreground/70 transition-colors duration-150 hover:bg-muted/65 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
        className,
      )}
    >
      {copied ? <CheckIcon size={14} weight="bold" aria-hidden /> : <CopySimpleIcon size={14} aria-hidden />}
    </button>
  );
}

function MarkdownParagraph({ children }: { children?: ReactNode }) {
  const copyText = textFromReactNode(children).trim();

  return (
    <p className={cn(copyText && "group relative pr-[32px]")}>
      {children}
      {copyText ? (
        <CopyIconButton
          text={copyText}
          label="Copy text block"
          copiedLabel="Text block copied"
          className="absolute top-[1px] right-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        />
      ) : null}
    </p>
  );
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const copyText = copyableCodeText(children);

  return (
    <div className="group relative my-3 max-w-full">
      <pre className="!my-0 pr-[44px]">{children}</pre>
      {copyText ? (
        <CopyIconButton
          text={copyText}
          label="Copy code block"
          copiedLabel="Code block copied"
          className="absolute top-[8px] right-[8px] bg-background/75 opacity-0 shadow-sm backdrop-blur group-hover:opacity-100 group-focus-within:opacity-100"
        />
      ) : null}
    </div>
  );
}

function MarkdownMessage({
  text,
  inProgress = false,
  copyBlocks = false,
}: {
  text: string;
  inProgress?: boolean;
  copyBlocks?: boolean;
}) {
  return (
    <div className={cn("markdown-body", inProgress && "sketch-response-fading")}>
      <ReactMarkdown
        components={copyBlocks ? markdownComponentsWithCopy : markdownComponents}
        remarkPlugins={markdownPlugins}
        skipHtml
      >
        {normalizeChatMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}
