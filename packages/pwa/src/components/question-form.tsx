import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
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
    answers?: readonly StructuredQuestionAnswer[],
    requestId?: string,
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
  /** Where the person can still answer when the daemon could not: the agent's own pane. */
  readonly onOpenConsole?: () => void;
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

const QUESTION_ALREADY_ANSWERED = 'question_already_answered';

/**
 * The refusals that mean the daemon tried the native form and could not answer it. The person can
 * still answer — in the agent's own pane, or in prose — so that is what they are told.
 */
const UNDELIVERED = new Set(['answer_unconfirmed', 'answer_released', 'session_answer_failed']);
const COULD_NOT_ANSWER = "Couldn't answer automatically — answer in the Console tab or type your choice in chat.";

/**
 * The drive stopped part-way through a multi-question form before submitting it. Nothing reached the
 * agent and the form is still open in the terminal, so sending the same answer again resumes it.
 */
const ANSWER_PAUSED = 'answer_paused';

interface AnswerError {
  readonly sentence: string;
  readonly detail?: string;
  /** The answer did not reach the form, so the Console is where it can still be given. */
  readonly console?: true;
  /** A paused drive: nothing was submitted, so the same answer can be sent again to resume it. */
  readonly resumable?: true;
  /** A paused drive: which questions the terminal's form already holds an answer for. */
  readonly answered?: readonly boolean[];
}

/**
 * What a failed answer says. A daemon that words its own refusal sends the sentence plus a `detail`;
 * an older one sends only its driver's evidence as the message, which is then kept for Details and
 * replaced on screen by the sentence a person can act on.
 */
function answerError(cause: unknown): AnswerError {
  const detail = bodyField(cause, 'detail');
  const message = cause instanceof Error ? cause.message : 'Answer could not be sent';
  if (cause instanceof FyHttpError && cause.code === ANSWER_PAUSED) {
    const answered = answeredField(cause);
    return {
      sentence: message,
      ...(detail === undefined ? {} : { detail }),
      console: true,
      resumable: true,
      ...(answered === undefined ? {} : { answered }),
    };
  }
  if (!(cause instanceof FyHttpError) || cause.code === undefined || !UNDELIVERED.has(cause.code))
    return { sentence: message, ...(detail === undefined ? {} : { detail }) };
  if (detail !== undefined) return { sentence: message, detail, console: true };
  return { sentence: COULD_NOT_ANSWER, detail: message, console: true };
}

/** The paused refusal's `answered` list, read only when it is the list of booleans it should be. */
function answeredField(cause: FyHttpError): readonly boolean[] | undefined {
  const value =
    typeof cause.body === 'object' && cause.body !== null
      ? (cause.body as Record<string, unknown>).answered
      : undefined;
  return Array.isArray(value) && value.every(item => typeof item === 'boolean') ? value : undefined;
}

/** One attempt's identity: the question plus a digest of the exact answer, so only a repeat is a replay. */
async function answerRequestId(
  daemonId: string,
  sessionId: string,
  toolUseId: string,
  answers: readonly StructuredQuestionAnswer[],
): Promise<string> {
  const body = JSON.stringify(
    answers.map(answer => (answer.kind === 'other' ? ['other', answer.text] : ['selection', [...answer.labels]])),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `question:${daemonId}:${sessionId}:${toolUseId}:${hex.slice(0, 32)}`;
}

const bodyField = (cause: unknown, field: string): string | undefined => {
  if (!(cause instanceof FyHttpError) || typeof cause.body !== 'object' || cause.body === null) return undefined;
  const value = (cause.body as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * Daemon-bound structured answer form. A multi-question request is paged only
 * on compact layouts, but both presentations share one answer state and one
 * submit path. Every question keeps its own selection cardinality; the ordered
 * `answers` payload preserves all labels even when a multi-question set embeds
 * a multi-select question.
 */
export function QuestionForm({
  api,
  daemon,
  sessionId,
  question,
  compact = false,
  onAnswered,
  onOpenConsole,
}: QuestionFormProps) {
  const formId = useId();
  const [answers, setAnswers] = useState(() => initialAnswers(question.questions.length));
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AnswerError | null>(null);
  const [alreadyAnswered, setAlreadyAnswered] = useState<string | null>(null);
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
    setAlreadyAnswered(null);
    submitLock.current = false;
  }, [daemon.daemonId, sessionId, question.toolUseId, question.questions.length]);

  const submit = async () => {
    if (!allAnswered(answers, question.questions.length) || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const structuredAnswers: StructuredQuestionAnswer[] = question.questions.map((_, index) =>
        answers.otherSelected[index]
          ? { kind: 'other', text: (answers.others[index] ?? '').trim() }
          : { kind: 'selection', labels: [...(answers.picks[index] ?? [])] },
      );
      const requestId = await answerRequestId(daemon.daemonId, sessionId, question.toolUseId, structuredAnswers);
      if (question.questions.length === 1) {
        await api.answer(
          daemon,
          sessionId,
          question.toolUseId,
          answers.picks[0] ?? [],
          answers.otherSelected[0] ? (answers.others[0] ?? '').trim() : undefined,
          undefined,
          structuredAnswers,
          requestId,
        );
      } else {
        const responses = question.questions.map((_, index) =>
          answers.otherSelected[index] ? (answers.others[index] ?? '').trim() : (answers.picks[index]?.[0] ?? ''),
        );
        await api.answer(daemon, sessionId, question.toolUseId, [], undefined, responses, structuredAnswers, requestId);
      }
      onAnswered?.();
    } catch (cause) {
      if (cause instanceof FyHttpError && cause.code === QUESTION_ALREADY_ANSWERED) {
        // The daemon already delivered an answer to this exact form. Keep the lock: nothing more can be sent.
        setAlreadyAnswered(bodyField(cause, 'answeredWith') ?? 'an earlier answer');
      } else {
        setError(answerError(cause));
        submitLock.current = false;
      }
    } finally {
      setSubmitting(false);
    }
  };

  const locked = submitting || alreadyAnswered !== null;
  const visible = paged ? [page] : question.questions.map((_, index) => index);
  const lastPage = page === question.questions.length - 1;

  return (
    <section aria-label="Answer session questions" className="fy-question-form" data-daemon-id={daemon.daemonId}>
      {visible.map(index => {
        const item = question.questions[index];
        if (!item) return null;
        const multiple = item.multiSelect === true;
        const other = answers.otherSelected[index] ?? false;
        return (
          <fieldset className="fy-question" key={`${question.toolUseId}:${index}`}>
            {paged ? (
              <p className="fy-eyebrow">
                Question {index + 1} of {question.questions.length}
              </p>
            ) : null}
            <legend>{item.header ?? `Question ${index + 1}`}</legend>
            {error?.answered?.[index] === true ? (
              <p className="fy-question-held" data-question-held="">
                Answered in the terminal
              </p>
            ) : null}
            <p>{item.question}</p>
            <div className="fy-question-options">
              {(item.options ?? []).map(option => (
                <label className="fy-question-option" key={option.label}>
                  <input
                    checked={!other && (answers.picks[index] ?? []).includes(option.label)}
                    disabled={locked}
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
                  disabled={locked}
                  name={`${formId}-${index}`}
                  onChange={() => setAnswers(current => selectOther(current, index))}
                  type={multiple ? 'checkbox' : 'radio'}
                />
                <span>Other…</span>
              </label>
              {other ? (
                <textarea
                  aria-label={`Other answer for question ${index + 1}`}
                  disabled={locked}
                  onChange={event => {
                    // Read BEFORE the updater: React clears `currentTarget` once the handler returns, and
                    // the updater runs later — reading it there throws and unmounts the whole page.
                    const { value } = event.currentTarget;
                    setAnswers(current => updateOther(current, index, value));
                  }}
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
            disabled={page === 0 || locked}
            onClick={() => setPage(current => Math.max(0, current - 1))}
            type="button"
          >
            Back
          </button>
          {lastPage ? (
            <button
              disabled={!allAnswered(answers, question.questions.length) || locked}
              onClick={() => void submit()}
              type="button"
            >
              {submitting ? 'Submitting…' : 'Submit answers'}
            </button>
          ) : (
            <button
              disabled={!answered(answers, page) || locked}
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
          disabled={!allAnswered(answers, question.questions.length) || locked}
          onClick={() => void submit()}
          type="button"
        >
          {submitting ? 'Submitting…' : 'Submit answer'}
        </button>
      )}
      {alreadyAnswered === null ? null : (
        <p data-question-answered="" role="status">
          This question was already answered with «{alreadyAnswered}».
        </p>
      )}
      {error ? <p role="alert">{error.sentence}</p> : null}
      {error?.resumable === true || (error?.console === true && onOpenConsole !== undefined) ? (
        <div className="fy-question-actions">
          {/* A paused form resumes from the terminal's own state: the daemon re-reads every tab and submits
              only once its review lists these answers, so sending them again cannot answer twice. */}
          {error?.resumable === true ? (
            <button className="fy-question-resume" disabled={locked} onClick={() => void submit()} type="button">
              Resume
            </button>
          ) : null}
          {error?.console === true && onOpenConsole !== undefined ? (
            <button className="fy-question-console" onClick={onOpenConsole} type="button">
              Open Console
            </button>
          ) : null}
        </div>
      ) : null}
      {error?.detail === undefined ? null : (
        <details className="text-meta text-muted">
          <summary>Details</summary>
          <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono">{error.detail}</pre>
        </details>
      )}
    </section>
  );
}
