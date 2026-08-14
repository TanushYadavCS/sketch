import type {
  WebChatQuestion,
  WebChatQuestionAnswer,
  WebChatQuestionBatch,
  WebChatQuestionBatchAnswer,
} from "@/lib/api";
import { cn } from "@sketch/ui/lib/utils";
import { useRef, useState } from "react";

export type QuestionFlowAnswer = WebChatQuestionAnswer;
export type QuestionFlowSubmission = QuestionFlowAnswer | WebChatQuestionBatchAnswer;

export interface QuestionFlowCardProps {
  question?: WebChatQuestion;
  batch?: WebChatQuestionBatch;
  disabled?: boolean;
  onSubmit?: (interaction: WebChatQuestion | WebChatQuestionBatch, answer: QuestionFlowSubmission) => void;
}

export function QuestionFlowCard({ question, batch, disabled = false, onSubmit }: QuestionFlowCardProps) {
  const questions = batch ? batch.questions : question ? [question] : [];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, QuestionFlowAnswer>>({});
  const finalSubmissionRef = useRef(false);
  const current = questions[index];
  const currentAnswer = current ? answers[current.id] : undefined;
  const currentOptionId = currentAnswer && "optionId" in currentAnswer ? currentAnswer.optionId : null;

  if (!current) return null;

  const finishOrAdvance = (answer: QuestionFlowAnswer) => {
    if (disabled || !onSubmit) return;
    const nextAnswers = { ...answers, [current.id]: answer };
    setAnswers(nextAnswers);
    if (index < questions.length - 1) {
      setIndex(index + 1);
      return;
    }
    if (finalSubmissionRef.current) return;
    finalSubmissionRef.current = true;
    if (batch) {
      onSubmit(batch, { batchId: batch.batchId, answers: questions.map((item) => nextAnswers[item.id]) });
    } else if (question) {
      onSubmit(question, answer);
    }
  };

  return (
    <section
      data-question-flow-card
      data-testid={batch ? "question-batch-card" : "question-card"}
      data-question-id={question?.id}
      data-question-batch-id={batch?.batchId}
      aria-live="polite"
      className="question-flow-card w-full max-w-[640px]"
    >
      <div key={current.id} data-question-flow-step data-transition="idle" className="min-h-0 pb-1">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-accent">Question</span>
          <span aria-live="polite" className="text-[12px] tabular-nums text-muted-foreground">
            {index + 1} of {questions.length}
          </span>
        </div>
        <fieldset disabled={disabled || !onSubmit} className="border-0 p-0">
          <legend className="px-0 text-[15px] font-medium leading-6 text-foreground">{current.prompt}</legend>
          <div className="mt-2.5 grid gap-2">
            {current.options.map((option) => (
              <button
                key={option.id}
                type="button"
                data-question-option-id={option.id}
                disabled={disabled || currentOptionId !== null}
                className={cn(
                  "rounded-[9px] border border-border/80 bg-background px-3 py-2 text-left transition hover:border-brand-accent/60 hover:bg-brand-accent/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55 disabled:cursor-not-allowed",
                  currentOptionId !== null &&
                    option.id !== currentOptionId &&
                    "border-border/40 bg-background/20 opacity-45",
                  currentOptionId === option.id && "border-brand-accent/70 bg-brand-accent/[0.08]",
                )}
                onClick={() => finishOrAdvance({ questionId: current.id, optionId: option.id })}
              >
                <span className="block text-[13px] font-medium text-foreground">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-[12px] leading-4 text-muted-foreground">{option.description}</span>
                ) : null}
              </button>
            ))}
          </div>
        </fieldset>
        {index > 0 ? (
          <button
            type="button"
            onClick={() => setIndex(index - 1)}
            disabled={disabled}
            className="mt-3 text-[12px] font-medium text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55"
          >
            Back
          </button>
        ) : null}
      </div>
    </section>
  );
}
