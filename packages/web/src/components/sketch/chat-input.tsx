import { type WebChatToolProgress, type WebChatUploadedAttachment, api } from "@/lib/api";
import {
  CaretDownIcon,
  MicrophoneIcon,
  PaperPlaneTiltIcon,
  PaperclipIcon,
  PauseIcon,
  StopIcon,
  WrenchIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { cn } from "@sketch/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

export interface ChatInputAttachment {
  file: File;
  uploaded?: WebChatUploadedAttachment;
  uploading?: boolean;
  error?: string;
}

export interface ChatInputRendererOption {
  value: WebChatToolProgress;
  label: string;
}

export interface ChatInputProps {
  initialValue?: string;
  placeholder?: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
  running?: boolean;
  runningPlaceholder?: string;
  stopping?: boolean;
  rendererValue?: WebChatToolProgress;
  rendererSaving?: boolean;
  rendererOptions?: ChatInputRendererOption[];
  onRendererChange?: (value: WebChatToolProgress) => void;
  onStop?: () => void;
  onSubmit?: (value: string, attachments: WebChatUploadedAttachment[]) => void;
}

const MIN_HEIGHT = 76;
const MAX_HEIGHT = 220;

function autosize(el: HTMLTextAreaElement) {
  el.style.height = "0px";
  const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
  el.style.height = `${next}px`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function supportedRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return RECORDING_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function recordingFilename(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/mp4") return "recording.m4a";
  if (normalized === "audio/ogg") return "recording.ogg";
  if (normalized === "audio/wav") return "recording.wav";
  return "recording.webm";
}

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput(
  {
    initialValue = "",
    placeholder = "Ask Sketch anything…",
    disabled = false,
    disabledPlaceholder = "Resolve account issue to continue",
    running = false,
    runningPlaceholder = "Sketch is working...",
    stopping = false,
    rendererValue,
    rendererSaving = false,
    rendererOptions = [],
    onRendererChange,
    onStop,
    onSubmit,
  },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const [attachments, setAttachments] = useState<ChatInputAttachment[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mountedRef = useRef(true);
  const discardRecordingRef = useRef(false);

  useImperativeHandle(ref, () => taRef.current as HTMLTextAreaElement, []);

  useEffect(() => {
    if (taRef.current) autosize(taRef.current);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardRecordingRef.current = true;
      const mediaRecorder = mediaRecorderRef.current;
      if (mediaRecorder) {
        mediaRecorder.ondataavailable = null;
        mediaRecorder.onstop = null;
        if (mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      }
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
      streamRef.current = null;
    };
  }, []);

  const hasUploadedAttachments = attachments.some((a) => a.uploaded);
  const hasContent = value.trim().length > 0 || hasUploadedAttachments;
  const hasPendingUploads = attachments.some((a) => a.uploading);
  const inputBusy = disabled || transcribing || running;
  const attachmentControlsBusy = inputBusy || running;

  function submitNow() {
    if (running) {
      onStop?.();
      return;
    }
    if (inputBusy || hasPendingUploads) return;
    const trimmed = value.trim();
    const uploaded = attachments.flatMap((a) => (a.uploaded ? [a.uploaded] : []));
    if (!trimmed && uploaded.length === 0) return;
    onSubmit?.(trimmed || "(attached files)", uploaded);
    setValue("");
    setAttachments([]);
    requestAnimationFrame(() => taRef.current && autosize(taRef.current));
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setValue(event.target.value);
    autosize(event.target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitNow();
    }
  }

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || attachmentControlsBusy) return;
      const newAttachments: ChatInputAttachment[] = Array.from(files).map((file) => ({
        file,
        uploading: true,
      }));
      setAttachments((prev) => [...prev, ...newAttachments]);

      for (const attachment of newAttachments) {
        api.webChat
          .uploadAttachment(attachment.file)
          .then((result) => {
            setAttachments((prev) =>
              prev.map((a) => (a.file === attachment.file ? { ...a, uploaded: result, uploading: false } : a)),
            );
          })
          .catch((err) => {
            setAttachments((prev) =>
              prev.map((a) =>
                a.file === attachment.file
                  ? { ...a, uploading: false, error: err instanceof Error ? err.message : "Upload failed" }
                  : a,
              ),
            );
          });
      }
    },
    [attachmentControlsBusy],
  );

  function removeAttachment(file: File) {
    setAttachments((prev) => prev.filter((a) => a.file !== file));
  }

  async function startRecording() {
    if (attachmentControlsBusy || recording) return;
    setVoiceError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("Voice recording is not available in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const mimeType = supportedRecordingMimeType();
      const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      discardRecordingRef.current = false;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        if (discardRecordingRef.current || !mountedRef.current) {
          chunksRef.current = [];
          return;
        }
        setRecording(false);
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
        if (mediaRecorderRef.current === mediaRecorder) {
          mediaRecorderRef.current = null;
        }
        const recordingType = mediaRecorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: recordingType });
        chunksRef.current = [];
        if (blob.size === 0) {
          setVoiceError("No audio was recorded.");
          return;
        }

        setTranscribing(true);
        setVoiceError(null);
        try {
          const { text } = await api.webChat.transcribe(blob, recordingFilename(recordingType));
          if (!mountedRef.current) return;
          if (text.trim()) {
            setValue((prev) => {
              const separator = prev.trim() ? " " : "";
              return `${prev}${separator}${text}`;
            });
            requestAnimationFrame(() => {
              if (taRef.current) {
                autosize(taRef.current);
                taRef.current.focus();
              }
            });
          } else {
            setVoiceError("No speech was detected.");
          }
        } catch (err) {
          if (!mountedRef.current) return;
          setVoiceError(err instanceof Error ? err.message : "Transcription failed.");
        } finally {
          if (mountedRef.current) setTranscribing(false);
        }
      };
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setRecording(true);
    } catch (err) {
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
      streamRef.current = null;
      if (mountedRef.current) setVoiceError(err instanceof Error ? err.message : "Microphone access failed.");
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitNow();
      }}
      className={cn(
        "group/input relative w-full rounded-[16px] border bg-card",
        "transition-all duration-150 ease-out",
        disabled
          ? "border-border opacity-90"
          : "border-border hover:border-foreground/25 focus-within:border-foreground/30 focus-within:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.08)]",
      )}
    >
      <textarea
        ref={taRef}
        rows={3}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={
          disabled
            ? disabledPlaceholder
            : transcribing
              ? "Transcribing audio..."
              : recording
                ? "Recording... click stop when done"
                : running
                  ? runningPlaceholder
                  : (voiceError ?? placeholder)
        }
        disabled={inputBusy}
        className={cn(
          "block w-full resize-none bg-transparent px-[18px] pt-[16px] pb-[6px]",
          "text-[15px] leading-[1.55] text-foreground placeholder:text-muted-foreground",
          "outline-none disabled:cursor-not-allowed",
        )}
        style={{ height: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
        aria-label="Message Sketch"
      />

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-[6px] px-[14px] pb-[6px]">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.file.name + attachment.file.lastModified}
              attachment={attachment}
              onRemove={() => removeAttachment(attachment.file)}
            />
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between px-[12px] pb-[12px] pt-[4px]">
        <div className="flex items-center gap-[6px]">
          <ProgressModeMenu
            value={rendererValue}
            saving={rendererSaving}
            options={rendererOptions}
            disabled={disabled || running}
            onChange={onRendererChange}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
            aria-hidden
          />
          <IconButton
            icon={<PaperclipIcon size={16} aria-hidden />}
            label="Attach a file"
            disabled={attachmentControlsBusy}
            onClick={() => fileInputRef.current?.click()}
          />
          {recording ? (
            <IconButton
              icon={<StopIcon size={16} weight="fill" aria-hidden />}
              label="Stop recording"
              disabled={false}
              onClick={stopRecording}
              active
            />
          ) : (
            <IconButton
              icon={<MicrophoneIcon size={16} aria-hidden />}
              label="Record voice"
              disabled={attachmentControlsBusy}
              onClick={startRecording}
              loading={transcribing}
            />
          )}
        </div>
        <div className="min-w-0 flex-1" />
        <SubmitButton
          disabled={inputBusy || hasPendingUploads}
          empty={!hasContent}
          running={running}
          stopping={stopping}
          onClick={submitNow}
        />
      </div>
    </form>
  );
});

function ProgressModeMenu({
  value,
  saving,
  options,
  disabled,
  onChange,
}: {
  value?: WebChatToolProgress;
  saving: boolean;
  options: ChatInputRendererOption[];
  disabled: boolean;
  onChange?: (value: WebChatToolProgress) => void;
}) {
  if (!value || options.length === 0 || !onChange) return null;
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Progress updates: ${selected.label}`}
          title={`Progress updates: ${selected.label}`}
          disabled={disabled || saving}
          className={cn(
            "flex h-[36px] w-[48px] shrink-0 items-center justify-center gap-[4px] rounded-full border border-border/70",
            "bg-muted/80 text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
            "transition-colors duration-150 ease-out",
            "hover:border-foreground/15 hover:bg-foreground/10 hover:text-foreground",
            "data-[state=open]:border-foreground/20 data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
            "disabled:cursor-not-allowed disabled:opacity-50",
            !disabled && !saving && "cursor-pointer",
          )}
        >
          <WrenchIcon size={16} aria-hidden />
          <CaretDownIcon size={11} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[190px] p-[6px] data-[state=closed]:!animate-none data-[state=open]:!animate-none"
      >
        <DropdownMenuLabel className="px-[8px] pt-[5px] pb-[4px] text-[11px] font-semibold leading-none tracking-normal text-muted-foreground">
          Progress updates
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-[4px]" />
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as WebChatToolProgress)}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className="h-[32px] cursor-pointer rounded-[7px] pl-[8px] text-[13px] data-[state=checked]:bg-muted/70"
            >
              <span className="flex min-w-0 flex-1 items-center">
                <span>{option.label}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IconButton({
  icon,
  label,
  disabled,
  onClick,
  active,
  loading,
}: {
  icon: ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
  active?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-busy={loading ? true : undefined}
      className={cn(
        "relative flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full",
        "transition-[background-color,color,transform,opacity] duration-150 ease-out cursor-pointer",
        active
          ? "bg-muted text-foreground hover:bg-foreground/15 hover:scale-[1.04] active:scale-[0.97]"
          : loading
            ? "bg-muted text-brand-accent cursor-wait"
            : "bg-muted text-muted-foreground hover:text-foreground hover:bg-foreground/15 hover:scale-[1.04] active:scale-[0.97]",
        disabled && !loading && "cursor-not-allowed opacity-50",
      )}
    >
      {loading ? (
        <span
          className="pointer-events-none absolute inset-[-2px] rounded-full border-[1.5px] animate-spin"
          style={{
            borderColor: "color-mix(in oklch, var(--brand-accent) 20%, transparent)",
            borderTopColor: "var(--brand-accent)",
          }}
          aria-hidden
        />
      ) : null}
      {icon}
    </button>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ChatInputAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.file.type.startsWith("image/");
  const previewUrl = useMemo(() => (isImage ? URL.createObjectURL(attachment.file) : null), [attachment.file, isImage]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div
      className={cn(
        "inline-flex max-w-[200px] items-center gap-[6px] rounded-[8px] border px-[8px] py-[5px] text-[12px]",
        attachment.error
          ? "border-red-500/40 bg-red-500/10 text-red-400"
          : attachment.uploading
            ? "border-border/60 bg-muted/40 text-muted-foreground animate-pulse"
            : "border-border bg-muted/50 text-foreground/80",
      )}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="h-[18px] w-[18px] shrink-0 rounded-[3px] object-cover" />
      ) : (
        <PaperclipIcon size={13} className="shrink-0" aria-hidden />
      )}
      <span className="truncate">{attachment.file.name}</span>
      {attachment.uploaded ? (
        <span className="shrink-0 text-muted-foreground/60">{formatFileSize(attachment.uploaded.sizeBytes)}</span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
        aria-label={`Remove ${attachment.file.name}`}
      >
        <XIcon size={12} aria-hidden />
      </button>
    </div>
  );
}

function SubmitButton({
  disabled,
  empty,
  running,
  stopping,
  onClick,
}: {
  disabled: boolean;
  empty: boolean;
  running: boolean;
  stopping: boolean;
  onClick: () => void;
}) {
  if (running) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={stopping}
        aria-label={stopping ? "Pausing Sketch" : "Pause Sketch"}
        aria-busy={stopping ? true : undefined}
        className={cn(
          "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full",
          "border border-border/70 bg-muted/80 text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
          "transition-colors duration-150 ease-out cursor-pointer hover:border-foreground/15 hover:bg-foreground/10 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:cursor-wait disabled:opacity-70",
        )}
      >
        <PauseIcon size={15} weight="fill" aria-hidden />
      </button>
    );
  }

  const ready = !disabled && !empty;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || empty}
      aria-label="Send message"
      className={cn(
        "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full",
        "transition-all duration-200 ease-out cursor-pointer",
        ready
          ? "bg-foreground text-background shadow-[0_2px_8px_rgba(0,0,0,0.16),0_0_18px_rgba(0,0,0,0.08)] hover:bg-foreground/90 hover:shadow-[0_2px_12px_rgba(0,0,0,0.18),0_0_24px_rgba(0,0,0,0.1)] dark:bg-brand-accent dark:text-black dark:shadow-[0_2px_8px_rgba(254,237,1,0.5),0_0_20px_rgba(254,237,1,0.25)] dark:hover:bg-brand-accent/90 dark:hover:shadow-[0_2px_12px_rgba(254,237,1,0.6),0_0_28px_rgba(254,237,1,0.3)] hover:scale-[1.04] active:scale-[0.97]"
          : "bg-muted text-muted-foreground/70 cursor-not-allowed",
      )}
    >
      <PaperPlaneTiltIcon size={14} weight="fill" aria-hidden />
    </button>
  );
}
