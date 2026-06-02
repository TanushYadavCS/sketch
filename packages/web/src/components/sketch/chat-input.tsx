import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export interface ChatInputProps {
  initialValue?: string;
  placeholder?: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
  onSubmit?: (value: string) => void;
}

const MIN_HEIGHT = 76;
const MAX_HEIGHT = 220;

function autosize(el: HTMLTextAreaElement) {
  el.style.height = "0px";
  const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
  el.style.height = `${next}px`;
}

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput(
  {
    initialValue = "",
    placeholder = "Ask Sketch anything…",
    disabled = false,
    disabledPlaceholder = "Resolve account issue to continue",
    onSubmit,
  },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(ref, () => taRef.current as HTMLTextAreaElement, []);

  useEffect(() => {
    if (taRef.current) autosize(taRef.current);
  }, []);

  function submitNow() {
    if (disabled) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit?.(trimmed);
    setValue("");
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

  const empty = value.trim().length === 0;

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
        placeholder={disabled ? disabledPlaceholder : placeholder}
        disabled={disabled}
        className={cn(
          "block w-full resize-none bg-transparent px-[18px] pt-[16px] pb-[6px]",
          "text-[15px] leading-[1.55] text-foreground placeholder:text-muted-foreground",
          "outline-none disabled:cursor-not-allowed",
        )}
        style={{ height: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
        aria-label="Message Sketch"
      />

      <div className="flex items-center justify-end px-[10px] pb-[10px] pt-[2px]">
        <SubmitButton disabled={disabled} empty={empty} onClick={submitNow} />
      </div>
    </form>
  );
});

function SubmitButton({ disabled, empty, onClick }: { disabled: boolean; empty: boolean; onClick: () => void }) {
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
          ? "bg-brand-yellow text-brand-brown shadow-[0_4px_14px_-2px_rgba(254,237,1,0.45)] hover:scale-[1.04] active:scale-[0.97]"
          : "bg-muted text-muted-foreground/70 cursor-not-allowed",
      )}
    >
      <PaperPlaneTiltIcon size={14} weight="fill" aria-hidden />
    </button>
  );
}
