import type { PendingQuestion } from '@ferretry/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';

export interface QuestionAnswerApi {
  /** The host must use this exact paired daemon; session ids are not fleet-global. */
  answer(
    daemon: DaemonConnection,
    sessionId: string,
    toolUseId: string,
    labels: readonly string[],
    other?: string,
    responses?: readonly string[],
  ): Promise<unknown>;
}

export interface QuestionFormProps {
  readonly api: QuestionAnswerApi;
  readonly daemon: DaemonConnection;
  readonly sessionId: string;
  readonly question: PendingQuestion;
  /** Phones page multi-question asks; desktop keeps the complete request visible. */
  readonly compact?: boolean;
  readonly onAnswered?: () => void;
}

interface AnswerState {
  readonly picks: readonly (readonly string[])[];
  readonly others: readonly string[];
  readonly otherSelected: readonly boolean[];
}

const initialAnswers = (count: number): AnswerState => ({
  picks: Array.from({ length: count }, () => []),
  others: Array.from({ length: count }, () => ''),
  otherSelected: Array.from({ length: count }, () => false),
});

const answered = (state: AnswerState, index: number): boolean =>
  state.otherSelected[index] ? (state.others[index] ?? '').trim() !== '' : (state.picks[index]?.length ?? 0) > 0;

const allAnswered = (state: AnswerState, count: number): boolean =>
  Array.from({ length: count }, (_, index) => answered(state, index)).every(Boolean);

const toggleOption = (state: AnswerState, index: number, label: string, multiple: boolean): AnswerState => {
  const picks = state.picks.map(values => [...values]);
  const current = picks[index] ?? [];
  picks[index] = multiple
    ? current.includes(label)
      ? current.filter(value => value !== label)
      : [...current, label]
    : [label];
  const otherSelected = [...state.otherSelected];
  otherSelected[index] = false;
  return { ...state, picks, otherSelected };
};

const selectOther = (state: AnswerState, index: number): AnswerState => {
  const picks = state.picks.map(values => [...values]);
  picks[index] = [];
  const otherSelected = [...state.otherSelected];
  otherSelected[index] = true;
  return { ...state, picks, otherSelected };
};

const updateOther = (state: AnswerState, index: number, value: string): AnswerState => {
  const others = [...state.others];
  others[index] = value;
  return { ...state, others };
};

/**
 * Daemon-bound structured answer form. A multi-question request is paged only
 * on compact layouts, but both presentations share one answer state and one
 * submit path. In particular, multi-question requests are radio choices: the
 * daemon protocol accepts exactly one response per question.
 */
export function QuestionForm({ api, daemon, sessionId, question, compact = false, onAnswered }: QuestionFormProps) {
  const formId = useId();
  const [answers, setAnswers] = useState(() => initialAnswers(question.questions.length));
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const paged = compact && question.questions.length > 1;

  // Scope identity and tool id are reset triggers: a same-named session on a
  // newly paired daemon must never retain the previous daemon's answers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate reset triggers
  useEffect(() => {
    setAnswers(initialAnswers(question.questions.length));
    setPage(0);
    setSubmitting(false);
    setError(null);
    submitLock.current = false;
  }, [daemon.daemonId, sessionId, question.toolUseId, question.questions.length]);

  const submit = async () => {
    if (!allAnswered(answers, question.questions.length) || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (question.questions.length === 1) {
        await api.answer(
          daemon,
          sessionId,
          question.toolUseId,
          answers.picks[0] ?? [],
          answers.otherSelected[0] ? (answers.others[0] ?? '').trim() : undefined,
        );
      } else {
        const responses = question.questions.map((_, index) =>
          answers.otherSelected[index] ? (answers.others[index] ?? '').trim() : (answers.picks[index]?.[0] ?? ''),
        );
        await api.answer(daemon, sessionId, question.toolUseId, [], undefined, responses);
      }
      onAnswered?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Answer could not be sent');
      submitLock.current = false;
    } finally {
      setSubmitting(false);
    }
  };

  const visible = paged ? [page] : question.questions.map((_, index) => index);
  const lastPage = page === question.questions.length - 1;

  return (
    <section aria-label="Answer session questions" className="fy-question-form" data-daemon-id={daemon.daemonId}>
      {visible.map(index => {
        const item = question.questions[index];
        if (!item) return null;
        const multiple = question.questions.length === 1 && item.multiSelect === true;
        const other = answers.otherSelected[index] ?? false;
        return (
          <fieldset className="fy-question" key={`${question.toolUseId}:${index}`}>
            {paged ? (
              <p className="fy-eyebrow">
                Question {index + 1} of {question.questions.length}
              </p>
            ) : null}
            <legend>{item.header ?? `Question ${index + 1}`}</legend>
            <p>{item.question}</p>
            <div className="fy-question-options">
              {(item.options ?? []).map(option => (
                <label className="fy-question-option" key={option.label}>
                  <input
                    checked={!other && (answers.picks[index] ?? []).includes(option.label)}
                    disabled={submitting}
                    name={`${formId}-${index}`}
                    onChange={() => setAnswers(current => toggleOption(current, index, option.label, multiple))}
                    type={multiple ? 'checkbox' : 'radio'}
                  />
                  <span>
                    {option.label}
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                </label>
              ))}
              <label className="fy-question-option">
                <input
                  checked={other}
                  disabled={submitting}
                  name={`${formId}-${index}`}
                  onChange={() => setAnswers(current => selectOther(current, index))}
                  type={multiple ? 'checkbox' : 'radio'}
                />
                <span>Other…</span>
              </label>
              {other ? (
                <textarea
                  aria-label={`Other answer for question ${index + 1}`}
                  disabled={submitting}
                  onChange={event => setAnswers(current => updateOther(current, index, event.currentTarget.value))}
                  placeholder="Type your response"
                  value={answers.others[index] ?? ''}
                />
              ) : null}
            </div>
          </fieldset>
        );
      })}
      {paged ? (
        <nav aria-label="Question progress" className="fy-question-nav">
          <button
            disabled={page === 0 || submitting}
            onClick={() => setPage(current => Math.max(0, current - 1))}
            type="button"
          >
            Back
          </button>
          {lastPage ? (
            <button
              disabled={!allAnswered(answers, question.questions.length) || submitting}
              onClick={() => void submit()}
              type="button"
            >
              {submitting ? 'Submitting…' : 'Submit answers'}
            </button>
          ) : (
            <button
              disabled={!answered(answers, page) || submitting}
              onClick={() => setPage(current => current + 1)}
              type="button"
            >
              Next
            </button>
          )}
        </nav>
      ) : (
        <button
          className="fy-question-submit"
          disabled={!allAnswered(answers, question.questions.length) || submitting}
          onClick={() => void submit()}
          type="button"
        >
          {submitting ? 'Submitting…' : 'Submit answer'}
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
