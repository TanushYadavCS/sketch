import type { AutomationArtifact } from "@/lib/api";
import { FileTextIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { type ReactNode, isValidElement } from "react";
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

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  createdAt?: string;
  files?: ChatThreadFile[];
  automations?: AutomationArtifact[];
  progressLines?: string[];
}

export interface ChatThreadProps {
  messages?: ChatThreadMessage[];
  busy?: boolean;
  error?: string | null;
  conversationId?: string;
  className?: string;
}

const markdownPlugins = [remarkGfm];

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

export function ChatThread({ messages = [], busy = false, error, conversationId, className }: ChatThreadProps) {
  if (messages.length === 0 && !busy && !error) return null;
  const showBusy = busy && messages.at(-1)?.role !== "assistant";

  return (
    <section aria-label="Chat thread" className={cn("flex flex-col gap-[24px]", className)}>
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} conversationId={conversationId} />
      ))}

      {showBusy ? (
        <SketchMessage streaming>
          <span className="text-muted-foreground italic">Thinking…</span>
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

function MessageRow({ message, conversationId }: { message: ChatThreadMessage; conversationId?: string }) {
  if (message.role === "user") {
    return (
      <UserMessage footer={<MessageTimestamp createdAt={message.createdAt} align="right" />}>
        <MessageContent message={message} conversationId={conversationId} />
      </UserMessage>
    );
  }

  if (message.progressLines?.length) {
    return (
      <SketchMessage streaming footer={<MessageTimestamp createdAt={message.createdAt} align="left" />}>
        <div className="sketch-text-thinking space-y-[2px] text-muted-foreground italic">
          {message.progressLines.map((line) => (
            <p key={line} className="whitespace-pre-wrap">
              {line}
            </p>
          ))}
        </div>
      </SketchMessage>
    );
  }

  return (
    <SketchMessage footer={<MessageTimestamp createdAt={message.createdAt} align="left" />}>
      <MessageContent message={message} conversationId={conversationId} />
    </SketchMessage>
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

function MessageTimestamp({ createdAt, align }: { createdAt?: string; align: "left" | "right" }) {
  if (!createdAt) return null;
  const label = formatMessageTime(createdAt);
  if (!label) return null;

  return (
    <time
      dateTime={createdAt}
      className={cn(
        "mt-[5px] block text-[11px] leading-none text-muted-foreground/65",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {label}
    </time>
  );
}

function MessageContent({ message, conversationId }: { message: ChatThreadMessage; conversationId?: string }) {
  const hasFiles = Boolean(message.files?.length);
  const hasAutomations = Boolean(message.automations?.length);
  if (!hasFiles && !hasAutomations) return message.text ? <MarkdownMessage text={message.text} /> : null;

  return (
    <div className="min-w-0 space-y-[10px]">
      {message.text ? <MarkdownMessage text={message.text} /> : null}
      {hasFiles ? (
        <div className="flex flex-wrap gap-[8px]">
          {message.files?.map((file) => (
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
      ) : null}
      {message.automations?.map((artifact) => (
        <AutomationArtifactCard key={artifact.taskId} artifact={artifact} conversationId={conversationId} />
      ))}
    </div>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins} skipHtml>
        {normalizeChatMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}
