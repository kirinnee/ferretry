import {
  isHarnessQuestionId,
  AGENDA_ASK_TARGET_LENGTH,
  type AgendaAsk,
  AgendaAskSchema,
  type AgendaItem,
  type AgendaQuestion,
  AgendaQuestionSchema,
  type AgendaResponse,
  kindOfAsk,
  MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH,
  MAX_AGENDA_QUESTION_LENGTH,
  MAX_AGENDA_QUESTIONS,
  MAX_AGENDA_SOURCE_REF_LENGTH,
  type PendingQuestion,
  PendingQuestionSchema,
  type ResolvedAgendaItem,
  SessionStatusSchema,
  SessionTurnStateSchema,
  type StructuredQuestionAnswer,
  toBullets,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { SerialExecutor } from '../ports.ts';
import type { AgendaBoardChange, AgendaChangeObserver, AgendaService } from './service.ts';
import type { AgendaActor, RaiseAgendaRequest } from './state-machine.ts';

/**
 * A harness parked on a prompt it owns — a structured question, a permission prompt, a dialog — waits on
 * the owner exactly like an item does, so it IS an item: the daemon raises one `question` item per wait,
 * clears it when the wait ends, and types the owner's answer into the form (docs/agenda.md).
 */
export const HARNESS_PROMPT_ACTOR: AgendaActor = { kind: 'daemon', cause: 'harness-prompt' };

/** A wait on a harness prompt that is not a structured question: the owner answers it in the Console. */
const PROMPT_REF_PREFIX = 'prompt:';

/** Whether a `question` item's source reference names a console prompt rather than a question form. */
export function isHarnessConsolePromptRef(sourceRef: string): boolean {
  return sourceRef.startsWith(PROMPT_REF_PREFIX);
}

/** A status that ends a session: nothing it was waiting on still waits. */
const ENDED = new Set(['completed', 'failed', 'stopped', 'kill_failed']);

/**
 * The few state fields a wait is read from. Everything else in the document is ignored, and a field that
 * does not parse reads as absent: a damaged document raises nothing rather than something wrong.
 */
const HarnessStateSchema = z.object({
  status: SessionStatusSchema.optional().catch(undefined),
  pendingQuestion: PendingQuestionSchema.nullable().optional().catch(undefined),
  turnState: SessionTurnStateSchema.optional().catch(undefined),
  turnStateAt: z.string().min(1).optional().catch(undefined),
  turnPrompt: z.string().min(1).optional().catch(undefined),
  permissionRequest: z
    .object({ id: z.string().min(1), question: z.string().min(1) })
    .optional()
    .catch(undefined),
  harnessDialog: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      kind: z.string().optional().catch(undefined),
      body: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  quota: z
    .object({ resetAt: z.number().finite().positive().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
type HarnessState = z.infer<typeof HarnessStateSchema>;

/** What one session is waiting on the owner for, as the item that says so. */
export interface HarnessWait {
  readonly sourceRef: string;
  readonly request: RaiseAgendaRequest;
}

/** One line, collapsed and trimmed at a word boundary with `…` when it runs over `limit`. */
function clip(text: string, limit: number): string {
  const line = text.replaceAll(/\s+/gu, ' ').trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Prose that may keep its line breaks, trimmed to `limit`. */
function clipProse(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

type PendingQuestionItem = PendingQuestion['questions'][number];

/** A pending question as the item asks it: its options kept only when they are valid answer choices. */
function agendaQuestion(question: PendingQuestionItem): AgendaQuestion {
  const text = clipProse(question.question, MAX_AGENDA_QUESTION_LENGTH);
  const options = question.options?.map(option => ({
    // A label is what the answer names, so it is never trimmed: an option whose label does not fit is
    // no option the item can offer, and the question is then answered in words.
    label: option.label,
    ...(option.description === undefined || option.description.trim() === ''
      ? {}
      : { description: clip(option.description, MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH) }),
  }));
  if (options === undefined) return { question: text };
  const withOptions = AgendaQuestionSchema.safeParse({ question: text, options });
  return withOptions.success ? withOptions.data : { question: text };
}

/** The ask a question form makes: a pick between options for one single-choice question, else words. */
function questionAsk(pending: PendingQuestion, questions: readonly AgendaQuestion[]): AgendaAsk {
  const only = pending.questions.length === 1 ? pending.questions[0] : undefined;
  const options = questions[0]?.options;
  if (only !== undefined && only.multiSelect !== true && options !== undefined) {
    const ask = AgendaAskSchema.safeParse({ kind: 'multiple-choice', options });
    if (ask.success) return ask.data;
  }
  return { kind: 'open-question' };
}

/** The item a pending structured question raises. `failed` says the last answer did not go through. */
export function harnessQuestionRequest(pending: PendingQuestion, failed = false): RaiseAgendaRequest {
  const questions = pending.questions.slice(0, MAX_AGENDA_QUESTIONS).map(agendaQuestion);
  const several = pending.questions.length > 1;
  const first = pending.questions[0]?.question ?? 'The ferret is waiting on a question';
  const ask = questionAsk(pending, questions);
  return {
    source: 'question',
    sourceRef: pending.toolUseId,
    title: failed ? 'Your answer did not arrive' : 'Question from the ferret',
    kind: kindOfAsk(ask),
    subject: failed ? 'Your answer did not reach the ferret. Answer again.' : clip(first, AGENDA_ASK_TARGET_LENGTH),
    why: 'The ferret stopped at a question form and cannot go on until it is answered.',
    context: toBullets([
      ...(failed ? ['Your last answer did not go through. The form is still open.'] : []),
      'The ferret is waiting on its own question form.',
      several ? `It asks ${pending.questions.length} questions. Answer each one.` : 'It asks one question.',
      'Your answer is typed into the form for you.',
    ]),
    howToResolve: 'Answer here and the form is filled in for you, or answer it in the Console tab.',
    ask,
    questions,
    ...(pending.askedAt === undefined ? {} : { waitingSince: pending.askedAt }),
  };
}

/** When a limit resets, in words a reader anywhere agrees on: `Nov 1, 00:00 UTC`. */
function resetWords(resetAt: number): string {
  const at = new Date(resetAt);
  const month = at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${String(at.getUTCDate())}, ${at.toISOString().slice(11, 16)} UTC`;
}

/** The item a session parked on "You've hit your … limit" raises: the login is spent, and it says until when. */
function usageLimitWait(state: HarnessState, sourceRef: string): HarnessWait {
  const dialog = state.harnessDialog;
  const notice = dialog?.body?.split('\n')[0]?.trim() || "The ferret's login hit its usage limit";
  const spend = /\bspend\b/iu.test(notice);
  const resets = state.quota?.resetAt === undefined ? undefined : resetWords(state.quota.resetAt);
  return {
    sourceRef,
    request: {
      source: 'question',
      sourceRef,
      title: spend ? 'Login hit its spend limit' : 'Login hit its usage limit',
      kind: 'info',
      subject: spend
        ? `The ferret's login hit its spend limit${resets === undefined ? '' : ` and resets ${resets}`}. Raise the limit or switch logins.`
        : `The ferret's login hit its usage limit${resets === undefined ? '' : ` and resets ${resets}`}. Wait or switch logins.`,
      why: "The ferret stopped on its harness's rate-limit dialog and cannot go on until the limit resets or someone chooses what to do.",
      context: toBullets([
        `It says: ${clip(notice, 200)}`,
        ...(resets === undefined ? ['The harness gave no reset time.'] : [`The limit resets ${resets}.`]),
        'Nothing was chosen for you: the dialog still waits in the Console.',
        'This clears by itself once the limit is gone and the dialog closes.',
      ]),
      howToResolve:
        'Ask your admin for more usage, or open the Console tab and pick what the ferret should do. Failover to another login follows your quota-failover settings.',
      ...(state.turnStateAt === undefined ? {} : { waitingSince: state.turnStateAt }),
    },
  };
}

/** The item a console prompt (a permission prompt, a dialog) raises: the owner answers it in the Console. */
function consolePromptWait(state: HarnessState): HarnessWait {
  const id = state.permissionRequest?.id ?? state.harnessDialog?.id ?? state.turnStateAt ?? 'current';
  const sourceRef = `${PROMPT_REF_PREFIX}${id}`.slice(0, MAX_AGENDA_SOURCE_REF_LENGTH);
  if (state.harnessDialog?.kind === 'usage-limit') return usageLimitWait(state, sourceRef);
  const asks = state.permissionRequest?.question ?? state.turnPrompt ?? state.harnessDialog?.title;
  const permission = state.permissionRequest !== undefined;
  return {
    sourceRef,
    request: {
      source: 'question',
      sourceRef,
      title: permission ? 'Permission for a command' : 'Ferret stuck on a prompt',
      kind: 'info',
      subject: permission
        ? 'The ferret needs your permission to go on. Answer it in the Console.'
        : 'The ferret is stuck on a prompt only you can answer. Open the Console.',
      why: 'The ferret is paused on a prompt from its own tool and cannot go on until someone answers it.',
      context: toBullets([
        permission ? 'It is asking permission before it takes a step.' : 'Its tool is showing a prompt.',
        ...(asks === undefined ? [] : [`It asks: ${clip(asks, 200)}`]),
        'This clears by itself once the prompt is answered.',
      ]),
      howToResolve: 'Open the Console tab and answer the prompt there.',
      ...(state.turnStateAt === undefined ? {} : { waitingSince: state.turnStateAt }),
    },
  };
}

/**
 * What a state document says the session is waiting on the owner for: a pending structured question,
 * else a console prompt while the turn needs input, else nothing — and nothing once the session ended.
 */
export function harnessWait(state: unknown): HarnessWait | undefined {
  const parsed = HarnessStateSchema.safeParse(state);
  if (!parsed.success) return undefined;
  const current = parsed.data;
  if (current.status !== undefined && ENDED.has(current.status)) return undefined;
  const pending = current.pendingQuestion ?? undefined;
  if (pending !== undefined) {
    // The ferret's harness wrote this id: one shaped like the daemon's own references is no question to raise.
    if (!isHarnessQuestionId(pending.toolUseId)) return undefined;
    return { sourceRef: pending.toolUseId, request: harnessQuestionRequest(pending) };
  }
  return current.turnState === 'needs-input' ? consolePromptWait(current) : undefined;
}

/**
 * The tool id of a pending question that is NOT raised because it is shaped like a daemon reference (docs/agenda.md §
 * Reserved sourceRefs), for the diagnostic; `undefined` for any other state.
 */
export function refusedQuestionId(state: unknown): string | undefined {
  const parsed = HarnessStateSchema.safeParse(state);
  const id = parsed.success ? parsed.data.pendingQuestion?.toolUseId : undefined;
  return id === undefined || isHarnessQuestionId(id) ? undefined : id;
}

/** Whether a board row is one this producer raised. */
export function isHarnessPromptItem(item: AgendaItem | ResolvedAgendaItem): boolean {
  return item.source === 'question' && item.raisedBy === 'daemon' && item.sourceRef !== null;
}

export type HarnessAnswerMapping =
  | { readonly ok: true; readonly answers: readonly StructuredQuestionAnswer[] }
  | { readonly ok: false; readonly reason: string };

const NO_ANSWER = '(no answer)';

/** One answer in words, as the form takes it: the option it names, the options a multi-select lists, else text. */
function answerFor(question: PendingQuestionItem, text: string): StructuredQuestionAnswer {
  const labels = (question.options ?? []).map(option => option.label);
  if (labels.includes(text)) return { kind: 'selection', labels: [text] };
  if (question.multiSelect === true) {
    const picked = [...new Set(text.split(/\s*[,\n]\s*/u).filter(part => part !== ''))];
    if (picked.length > 0 && picked.every(label => labels.includes(label)))
      return { kind: 'selection', labels: picked };
  }
  return { kind: 'other', text };
}

/**
 * The per-question answers of one reply the board numbered by question — `1. <question>\n→ <answer>`,
 * blank line between (`composeQuestionAnswers` in the app) — in question order, or `undefined` when the
 * reply is not in that shape.
 */
function numberedAnswers(text: string, count: number): readonly string[] | undefined {
  const heads = [...text.matchAll(/(?:^|\n\n)(\d+)\. [^\n]*\n→ /gu)];
  if (heads.length !== count) return undefined;
  if (heads.some((head, index) => Number(head[1]) !== index + 1)) return undefined;
  return heads.map((head, index) => {
    const start = (head.index ?? 0) + head[0].length;
    const end = heads[index + 1]?.index ?? text.length;
    return text.slice(start, end).trim();
  });
}

/** The owner's answer on the board, as the answers the question form is driven with. */
export function harnessQuestionAnswers(pending: PendingQuestion, response: AgendaResponse): HarnessAnswerMapping {
  const { questions } = pending;
  if (response.kind === 'multiple-choice') {
    const only = questions.length === 1 ? questions[0] : undefined;
    if (only?.options?.some(option => option.label === response.choice) !== true)
      return { ok: false, reason: 'the chosen option is not one the question form offers' };
    return { ok: true, answers: [{ kind: 'selection', labels: [response.choice] }] };
  }
  if (response.kind === 'other') return { ok: false, reason: 'an answer outside the options cannot fill a form' };
  if (response.kind !== 'open-question') return { ok: false, reason: `a ${response.kind} answer cannot fill a form` };
  const answer = response.answer.trim();
  const only = questions.length === 1 ? questions[0] : undefined;
  if (only !== undefined) return { ok: true, answers: [answerFor(only, answer)] };
  const parts = numberedAnswers(answer, questions.length);
  if (parts === undefined)
    return { ok: false, reason: `the reply does not answer each of the ${questions.length} questions in turn` };
  if (parts.some(part => part === '' || part === NO_ANSWER))
    return { ok: false, reason: 'the form needs an answer to every question' };
  return {
    ok: true,
    answers: parts.map((part, index) => answerFor(questions[index] as PendingQuestionItem, part)),
  };
}

/** The live form a board answer is typed into: the EXISTING structured-answer path, never a second driver. */
export interface HarnessQuestionAnswerer {
  /** The question the session is parked on now, re-read; `undefined` when none is. */
  pending(sessionId: string): Promise<PendingQuestion | undefined>;
  /** Drives the answer into the form; rejects when it could not be delivered. */
  answer(
    sessionId: string,
    request: {
      readonly toolUseId: string;
      readonly answers: readonly StructuredQuestionAnswer[];
      readonly requestId: string;
    },
  ): Promise<void>;
}

/** Where an answer that did not reach the form is recorded, so it is never dropped in silence. */
export interface HarnessPromptJournal {
  answerFailed(
    sessionId: string,
    failure: { readonly id: string; readonly toolUseId: string; readonly reason: string },
  ): Promise<void>;
}

type HarnessAgenda = Pick<AgendaService, 'list' | 'raise' | 'resolveSource'>;

/**
 * Raises and clears the board item for each session's harness wait, fed every state document storage
 * writes (and once, at start, every session's).
 *
 * ONE ITEM PER WAIT. The wait's source reference is the item's identity: the question's tool id, or the
 * console prompt's. A wait whose item was already answered or dismissed is never raised again — the
 * board's resolved history is the durable memory of that — so a restart, a repeated state write or a
 * dismissal never notifies twice. A wait that ends resolves its item in the daemon's name.
 *
 * Serialized per session, and a state write whose wait did not change does no I/O at all.
 */
/** What a session whose last settle failed is remembered as: never equal to a wait's key. */
const UNSETTLED = '\u0000unsettled';

export class HarnessPromptAgenda {
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly legacyAttention: HarnessAgenda,
    private readonly serial: Pick<SerialExecutor, 'run'>,
    private readonly states: { read(sessionId: string): Promise<unknown> },
    /** Where a refused question is told: one shaped like a daemon reference raises nothing. */
    private readonly diagnostics: { warn(message: string): void } = { warn: () => undefined },
  ) {}

  /** A state document was written. Total: a failure is retried at the next write. */
  async stateWritten(sessionId: string, state: unknown): Promise<void> {
    const wait = harnessWait(state);
    const key = wait?.sourceRef ?? '';
    if (this.seen.get(sessionId) === key) return;
    const refused = refusedQuestionId(state);
    if (refused !== undefined) {
      this.diagnostics.warn(
        `${sessionId}: a question whose id (${refused.slice(0, 80)}) is shaped like a daemon reference was not raised`,
      );
    }
    // A session with no wait and nothing open on its board has nothing to clear.
    if (wait === undefined && !this.seen.has(sessionId) && !hasOpenAgenda(state)) {
      this.seen.set(sessionId, key);
      return;
    }
    this.seen.set(sessionId, key);
    await this.settle(sessionId, wait).catch(() => {
      // Remembered as unsettled rather than forgotten: the next write must look at the board again.
      this.seen.set(sessionId, UNSETTLED);
    });
  }

  /** Brings every named session's board in line with its state, one at a time, each on its own. */
  async reconcile(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const state = await this.states.read(sessionId).catch(() => undefined);
      if (state !== undefined) await this.stateWritten(sessionId, state);
    }
  }

  private async settle(sessionId: string, wait: HarnessWait | undefined): Promise<void> {
    await this.serial.run(`harness-prompt:${sessionId}`, async () => {
      const listed = await this.legacyAttention.list(sessionId);
      if (!listed.ok) throw new Error(listed.error.message);
      const ours = listed.value.items.filter(isHarnessPromptItem);
      for (const item of ours) {
        if (item.sourceRef === wait?.sourceRef || item.sourceRef === null) continue;
        const resolved = await this.legacyAttention.resolveSource(
          sessionId,
          'question',
          item.sourceRef,
          HARNESS_PROMPT_ACTOR,
          'The ferret is no longer waiting on this.',
        );
        if (!resolved.ok) throw new Error(resolved.error.message);
      }
      if (wait === undefined || ours.some(item => item.sourceRef === wait.sourceRef)) return;
      if (listed.value.resolved.some(item => isHarnessPromptItem(item) && item.sourceRef === wait.sourceRef)) return;
      const raised = await this.legacyAttention.raise(sessionId, wait.request, HARNESS_PROMPT_ACTOR);
      if (!raised.ok) throw new Error(raised.error.message);
    });
  }
}

function hasOpenAgenda(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  const { agenda, attention: legacyAttention } = state as { agenda?: unknown; attention?: unknown };
  return (agenda ?? legacyAttention) !== undefined;
}

/**
 * Types the owner's board answer to a question item into the harness's form, through the existing
 * structured-answer path.
 *
 * Only the owner's own answer on the board drives: a chat reply already reached the ferret in words, and
 * a dismissal leaves the form exactly as it is. An answer that does not reach the form is journalled and,
 * while the form is still open, raised again as a new item saying so — never dropped in silence.
 */
export class HarnessPromptAnswerDelivery implements AgendaChangeObserver {
  constructor(
    private readonly harness: HarnessQuestionAnswerer,
    private readonly journal: HarnessPromptJournal,
    private readonly attention: Pick<AgendaService, 'raise'>,
  ) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    const item = change.addressed;
    if (change.change !== 'answered' || change.via !== 'board' || change.actor.kind !== 'human') return;
    if (item === undefined || item.response === undefined || !isHarnessPromptItem(item)) return;
    const toolUseId = item.sourceRef as string;
    if (isHarnessConsolePromptRef(toolUseId)) return;
    const failure = await this.drive(sessionId, item.id, toolUseId, item.response);
    if (failure === undefined) return;
    await this.journal
      .answerFailed(sessionId, { id: item.id, toolUseId, reason: failure.reason })
      .catch(() => undefined);
    if (failure.stillPending !== undefined)
      await this.attention
        .raise(sessionId, harnessQuestionRequest(failure.stillPending, true), HARNESS_PROMPT_ACTOR)
        .catch(() => undefined);
  }

  private async drive(
    sessionId: string,
    id: string,
    toolUseId: string,
    response: AgendaResponse,
  ): Promise<{ readonly reason: string; readonly stillPending?: PendingQuestion } | undefined> {
    const pending = await this.pendingNow(sessionId, toolUseId);
    if (pending === undefined) return { reason: 'the question was no longer waiting when the answer arrived' };
    const mapped = harnessQuestionAnswers(pending, response);
    if (!mapped.ok) return { reason: mapped.reason, stillPending: pending };
    try {
      await this.harness.answer(sessionId, {
        toolUseId,
        answers: mapped.answers,
        requestId: `attention:${sessionId}:${id}`,
      });
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const still = await this.pendingNow(sessionId, toolUseId);
      return still === undefined ? { reason } : { reason, stillPending: still };
    }
  }

  private async pendingNow(sessionId: string, toolUseId: string): Promise<PendingQuestion | undefined> {
    const pending = await this.harness.pending(sessionId).catch(() => undefined);
    return pending?.toolUseId === toolUseId ? pending : undefined;
  }
}
