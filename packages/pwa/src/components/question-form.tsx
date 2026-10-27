import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { Check, ListChecks } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import {
  type AnswerState,
  allAnswered,
  answered,
  answerText,
  initialAnswers,
  questionKeys,
  type QuestionDraftStore,
  questionDrafts,
  selectOther,
  toggleOption,
  updateOther,
} from './question-form-model.ts';

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
  readonly onAnswered?: () => void;
  /** Where the person can still answer when the daemon could not: the agent's own pane. */
  readonly onOpenConsole?: () => void;
  /** Where unsent answers are kept while the form is remounted; defaults to the page-wide store. */
  readonly drafts?: QuestionDraftStore;
}

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

interface FormView {
  /** The question this view belongs to; a different question starts a fresh view. */
  readonly key: string;
  readonly answers: AnswerState;
  readonly step: number;
  readonly submitting: boolean;
  readonly error: AnswerError | null;
  readonly alreadyAnswered: string | null;
}

const freshView = (key: string, count: number, drafts: QuestionDraftStore): FormView => {
  const draft = drafts.load(key);
  return {
    key,
    answers: draft?.answers ?? initialAnswers(count),
    // A single question has one step; a form of several ends in the review page, one step past the last.
    step: Math.min(Math.max(draft?.step ?? 0, 0), count > 1 ? count : 0),
    submitting: false,
    error: null,
    alreadyAnswered: null,
  };
};

/**
 * Daemon-bound structured answer form. A single question is shown as it is; several are asked one at a
 * time and end in a review page that lists every answer (each one tappable to change it) before the one
 * submit. The step scrolls inside a box that fits the screen, so no question, option or button is ever
 * clipped or out of reach. Every question keeps its own selection cardinality; the ordered `answers`
 * payload preserves all labels even when a multi-question set embeds a multi-select question.
 */
export function QuestionForm({
  api,
  daemon,
  sessionId,
  question,
  onAnswered,
  onOpenConsole,
  drafts = questionDrafts,
}: QuestionFormProps) {
  const formId = useId();
  const count = question.questions.length;
  const stepped = count > 1;
  const review = count;
  // Scope identity and tool id decide whose answers these are: a same-named session on a newly paired
  // daemon must never retain the previous daemon's answers.
  const scopeKey = `${daemon.daemonId}\u0000${sessionId}\u0000${question.toolUseId}\u0000${count}`;
  const [stored, setView] = useState<FormView>(() => freshView(scopeKey, count, drafts));
  const view = stored.key === scopeKey ? stored : freshView(scopeKey, count, drafts);
  if (stored.key !== scopeKey) setView(view);
  const { answers, step, submitting, error, alreadyAnswered } = view;
  const patch = (change: Partial<FormView>) => setView(current => ({ ...current, ...change }));
  const setAnswers = (change: (current: AnswerState) => AnswerState) =>
    setView(current => ({ ...current, answers: change(current.answers) }));

  const submitLock = useRef<string | null>(null);
  const titleRef = useRef<HTMLElement | null>(null);
  const setTitle = (node: HTMLElement | null) => {
    titleRef.current = node;
  };
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const focusOther = useRef(false);
  const shownStep = useRef(step);

  useEffect(() => {
    drafts.save(scopeKey, { answers, step });
  }, [drafts, scopeKey, answers, step]);

  // Moving to another step puts the reader at its title, so a screen reader announces it and the next
  // thing to Tab to is its first option — without opening a phone keyboard, which a text field would.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    titleRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!focusOther.current || !answers.otherSelected[step]) return;
    focusOther.current = false;
    otherRef.current?.focus();
  }, [answers.otherSelected, step]);

  const goTo = (target: number) => patch({ step: Math.min(Math.max(target, 0), stepped ? review : 0) });

  const submit = async () => {
    if (!allAnswered(answers, count) || submitLock.current === scopeKey) return;
    submitLock.current = scopeKey;
    patch({ submitting: true, error: null });
    try {
      const structuredAnswers: StructuredQuestionAnswer[] = question.questions.map((_, index) =>
        answers.otherSelected[index]
          ? { kind: 'other', text: (answers.others[index] ?? '').trim() }
          : { kind: 'selection', labels: [...(answers.picks[index] ?? [])] },
      );
      const requestId = await answerRequestId(daemon.daemonId, sessionId, question.toolUseId, structuredAnswers);
      if (count === 1) {
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
      drafts.clear(scopeKey);
      onAnswered?.();
    } catch (cause) {
      if (cause instanceof FyHttpError && cause.code === QUESTION_ALREADY_ANSWERED) {
        // The daemon already delivered an answer to this exact form. Keep the lock: nothing more can be sent.
        patch({ alreadyAnswered: bodyField(cause, 'answeredWith') ?? 'an earlier answer' });
      } else {
        patch({ error: answerError(cause) });
        submitLock.current = null;
      }
    } finally {
      patch({ submitting: false });
    }
  };

  const locked = submitting || alreadyAnswered !== null;
  const complete = allAnswered(answers, count);
  const keys = questionKeys(
    question.toolUseId,
    question.questions.map(item => item.question),
  );
  const labelOf = (index: number) => question.questions[index]?.header ?? `Question ${index + 1}`;

  /** Enter on a focused option: an unpicked one is picked, a picked one moves on. */
  const optionEnter = (
    event: KeyboardEvent<HTMLInputElement>,
    index: number,
    checked: boolean,
    pick: () => void,
  ): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (locked) return;
    if (!checked) {
      pick();
      return;
    }
    if (!answered(answers, index)) {
      otherRef.current?.focus();
      return;
    }
    if (stepped) goTo(index + 1);
    else void submit();
  };

  const renderQuestion = (index: number) => {
    const item = question.questions[index];
    if (!item) return null;
    const multiple = item.multiSelect === true;
    const other = answers.otherSelected[index] ?? false;
    return (
      <fieldset className="fy-question" key={`${question.toolUseId}:${index}`}>
        <legend ref={setTitle} tabIndex={-1}>
          {item.header ?? `Question ${index + 1}`}
        </legend>
        {error?.answered?.[index] === true ? (
          <p className="fy-question-held" data-question-held="">
            Answered in the terminal
          </p>
        ) : null}
        <p className="fy-question-text">{item.question}</p>
        {multiple ? <p className="fy-question-hint">Pick one or more</p> : null}
        <div className="fy-question-options">
          {(item.options ?? []).map(option => {
            const checked = !other && (answers.picks[index] ?? []).includes(option.label);
            const pick = () => setAnswers(current => toggleOption(current, index, option.label, multiple));
            return (
              <label className="fy-question-option" key={option.label}>
                <input
                  checked={checked}
                  disabled={locked}
                  name={`${formId}-${index}`}
                  onChange={pick}
                  onKeyDown={event => optionEnter(event, index, checked, pick)}
                  type={multiple ? 'checkbox' : 'radio'}
                />
                <span>
                  {option.label}
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </label>
            );
          })}
          <label className="fy-question-option">
            <input
              checked={other}
              disabled={locked}
              name={`${formId}-${index}`}
              onChange={() => {
                focusOther.current = true;
                setAnswers(current => selectOther(current, index));
              }}
              onKeyDown={event =>
                optionEnter(event, index, other, () => {
                  focusOther.current = true;
                  setAnswers(current => selectOther(current, index));
                })
              }
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
              onFocus={event => event.currentTarget.scrollIntoView?.({ block: 'nearest' })}
              onKeyDown={event => {
                if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (locked || !answered(answers, index)) return;
                if (stepped) goTo(index + 1);
                else void submit();
              }}
              placeholder="Type your response"
              ref={otherRef}
              value={answers.others[index] ?? ''}
            />
          ) : null}
        </div>
      </fieldset>
    );
  };

  const renderReview = () => (
    <section aria-label="Review your answers" className="fy-question-review">
      <h3 className="fy-question-review-title" ref={setTitle} tabIndex={-1}>
        Review your answers
      </h3>
      <ol className="fy-question-review-list">
        {question.questions.map((item, index) => {
          const text = answerText(answers, index);
          return (
            <li key={keys[index]}>
              <button
                aria-label={`Change answer to ${labelOf(index)}`}
                className="fy-question-review-row"
                data-answered={text === null ? 'false' : 'true'}
                disabled={locked}
                onClick={() => goTo(index)}
                type="button"
              >
                <span className="fy-question-review-q">
                  {labelOf(index)}
                  <small>{item.question}</small>
                </span>
                <span className="fy-question-review-a">
                  {text ?? 'Not answered yet'}
                  {error?.answered?.[index] === true ? <small>Answered in the terminal</small> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {complete ? null : <p className="fy-question-hint">Answer every question to submit.</p>}
    </section>
  );

  return (
    <section
      aria-label="Answer session questions"
      className="fy-question-form"
      data-daemon-id={daemon.daemonId}
      data-stepper={stepped ? '' : undefined}
    >
      {stepped ? (
        <header className="fy-question-head">
          <p aria-live="polite" className="fy-eyebrow">
            {step === review ? `Review · ${count} questions` : `Question ${step + 1} of ${count}`}
          </p>
          <nav aria-label="Question progress">
            <ol className="fy-question-steps">
              {question.questions.map((_, index) => {
                const done = answered(answers, index);
                const current = step === index;
                return (
                  <li key={keys[index]}>
                    <button
                      aria-current={current ? 'step' : undefined}
                      aria-label={`Question ${index + 1} of ${count}, ${labelOf(index)}, ${done ? 'answered' : 'not answered'}`}
                      className="fy-question-step"
                      data-answered={done ? 'true' : 'false'}
                      data-current={current ? 'true' : 'false'}
                      disabled={locked}
                      onClick={() => goTo(index)}
                      type="button"
                    >
                      {done ? <Check aria-hidden="true" size={14} /> : <span aria-hidden="true">{index + 1}</span>}
                      {current ? <span className="fy-question-step-label">{labelOf(index)}</span> : null}
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  aria-current={step === review ? 'step' : undefined}
                  aria-label="Review answers"
                  className="fy-question-step"
                  data-answered={complete ? 'true' : 'false'}
                  data-current={step === review ? 'true' : 'false'}
                  disabled={locked}
                  onClick={() => goTo(review)}
                  type="button"
                >
                  <ListChecks aria-hidden="true" size={14} />
                  {step === review ? <span className="fy-question-step-label">Review</span> : null}
                </button>
              </li>
            </ol>
          </nav>
        </header>
      ) : null}
      <div className="fy-question-body">{step === review && stepped ? renderReview() : renderQuestion(step)}</div>
      <div className="fy-question-foot">
        {stepped ? (
          <nav aria-label="Question navigation" className="fy-question-nav">
            <button disabled={step === 0 || locked} onClick={() => goTo(step - 1)} type="button">
              Back
            </button>
            {step === review ? (
              <button
                className="fy-question-submit"
                disabled={!complete || locked}
                onClick={() => void submit()}
                type="button"
              >
                {submitting ? 'Submitting…' : 'Submit answers'}
              </button>
            ) : (
              <button disabled={!answered(answers, step) || locked} onClick={() => goTo(step + 1)} type="button">
                {step === count - 1 ? 'Review' : 'Next'}
              </button>
            )}
          </nav>
        ) : (
          <button
            className="fy-question-submit"
            disabled={!complete || locked}
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
          <details className="fy-question-details text-meta text-muted">
            <summary>Details</summary>
            <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono">{error.detail}</pre>
          </details>
        )}
      </div>
    </section>
  );
}
