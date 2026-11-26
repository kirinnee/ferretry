import { createHash } from 'node:crypto';
import {
  type AgendaFormField,
  AgendaFormFieldSchema,
  AskRefusedError,
  type AskSummary,
  type AsksApi,
  type CloseReason,
  type EntryId,
  EntryIdSchema,
  type SourceKey,
  agendaFormProblems,
} from '@ferretry/core-asks/contract';
import { ZodError } from 'zod';
import type { Question } from '../../../contract/index.ts';

/** The ask source Conversation registers (`ask.sources:question`): the agenda draws it with the `ask:question` renderer. */
const QUESTION_SOURCE = 'question' as SourceKey;

/** What the question obligations need of Asks: raise (idempotent by source and entry), read what is open, and close. */
export type QuestionAsksPort = Pick<AsksApi, 'raise' | 'open' | 'close'>;

const MAX_SUBJECT = 240;

/**
 * The obligation's entry id: the ferret and the tool-use id together (two ferrets may use the same call id), as written
 * when that fits Asks' entry grammar and as a digest when it does not, so the key is always valid and always the same.
 */
export function questionEntry(ferret: string, toolUseId: string): EntryId {
  const plain = EntryIdSchema.safeParse(`${ferret}:${toolUseId}`);
  if (plain.success) return plain.data;
  const digest = createHash('sha256').update(ferret).update('\0').update(toolUseId).digest('hex').slice(0, 40);
  return EntryIdSchema.parse(`q:${digest}`);
}

/** One line, bounded: the question's words as the agenda card's subject. */
const subjectOf = (text: string): string => {
  const line = text.replace(/\s+/gu, ' ').trim();
  const words = line === '' ? 'A question for you' : line;
  return words.length <= MAX_SUBJECT ? words : `${words.slice(0, MAX_SUBJECT - 1)}…`;
};

/**
 * The form a question is on the card: one field per question it asks (the first, then each of `more`), a pick-one or
 * pick-many when it has options to pick from and the reply box when it has none. `undefined` when the board cannot hold
 * it as a form (a form has one reply box, and its fields and options have bounds): the card is then an open question,
 * which the owner still answers through Conversation's own route.
 */
function questionFields(question: Question): readonly AgendaFormField[] | undefined {
  const asked = [question, ...(question.more ?? [])];
  const fields = asked.map((each, index) => ({
    id: String(index + 1),
    type: each.options.length < 2 ? 'text' : each.multiple ? 'many' : 'one',
    label: each.text.trim() === '' ? 'Your answer' : each.text,
    ...(each.header === undefined || each.header.trim() === '' ? {} : { name: each.header }),
    ...(each.options.length < 2
      ? {}
      : {
          options: each.options.map(option => ({
            label: option.label,
            ...(option.description === undefined || option.description === ''
              ? {}
              : { description: option.description }),
          })),
        }),
  }));
  const parsed = AgendaFormFieldSchema.array().min(1).safeParse(fields);
  if (!parsed.success || agendaFormProblems({ kind: 'form', fields: parsed.data }).length > 0) return undefined;
  return parsed.data;
}

/** What the engine says of a request that is wrong in itself: asking again, on any board, says no again. */
const PERMANENT_CODES: readonly (string | undefined)[] = ['invalid', 'too-long'];

/** How the board answered a raise it READ and refused: for good (the draft is wrong), or for now (the board is full). */
const refusalOf = (error: unknown): 'permanent' | 'for-now' | undefined => {
  if (error instanceof ZodError) return 'permanent';
  if (!(error instanceof AskRefusedError)) return undefined;
  return PERMANENT_CODES.includes(error.code) ? 'permanent' : 'for-now';
};

type Owed =
  | { readonly kind: 'raise'; readonly ferret: string; readonly question: Question }
  | { readonly kind: 'close'; readonly entry: EntryId; readonly reason: CloseReason };

/**
 * THE QUESTION OBLIGATIONS: a stored `question.json` is an obligation on the Agenda (Asks' source `question`), keyed by
 * ferret and tool-use id, for either harness. Raising is idempotent (a second raise for the same question finds the
 * first), closing names that exact question's entry, and a raise or a close that failed is owed and tried again by
 * {@link settle}, so a transient Asks failure never leaves a card missing or stale. Answering is not here: the owner
 * answers through Conversation's own owner-only route.
 */
export class QuestionAsks {
  readonly #owed = new Map<string, Owed>();

  /** The raises the board refused for now (it is full): said once, then asked again only when the board changes. */
  readonly #waiting = new Set<string>();

  /**
   * `refused` hears a raise the board refused, once. `permanent`: the question itself is wrong, so it is dropped (the
   * same question would be refused again). `for-now`: the board is full or busy, so the raise stays owed and is asked
   * again by {@link retryWaiting} when the board changes. An Asks that could not be reached is neither: it stays owed
   * and is tried again by {@link settle}.
   */
  constructor(
    private readonly asks: QuestionAsksPort,
    private readonly refused: (ferret: string, error: unknown, outcome: 'permanent' | 'for-now') => void = () =>
      undefined,
  ) {}

  /**
   * The question is open: its card is on the Agenda (once). Throws when Asks could not be reached; the raise is then
   * owed. A question the board refuses is said once through `refused` and settles there.
   */
  async raise(ferret: string, question: Question): Promise<void> {
    const entry = questionEntry(ferret, question.toolUseId);
    const key = `raise:${entry}`;
    try {
      // The stored file's proof of its transcript is the daemon's own; the card carries the question only.
      const { transcript: _proof, conversation: _conversation, ...shown } = question;
      const fields = questionFields(question);
      await this.asks.raise({
        source: QUESTION_SOURCE,
        ref: shown,
        entry,
        kind: fields === undefined ? 'reply' : 'form',
        ...(fields === undefined ? {} : { fields: [...fields] }),
        subject: subjectOf(question.text),
        why: `${ferret} is waiting on your answer.`,
        howToResolve: 'Answer the question here or in the ferret’s chat; the answer is typed into its own form.',
        raisedBy: { kind: 'daemon' },
        ferret,
        blocking: true,
      });
      this.#owed.delete(key);
      this.#waiting.delete(key);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === 'permanent') {
        this.#owed.delete(key);
        this.#waiting.delete(key);
        this.refused(ferret, error, 'permanent');
        return;
      }
      if (refusal === 'for-now') {
        this.#owed.set(key, { kind: 'raise', ferret, question });
        if (!this.#waiting.has(key)) {
          this.#waiting.add(key);
          this.refused(ferret, error, 'for-now');
        }
        return;
      }
      // Not a refusal: Asks could not be reached, so it is the next look's, not the board's change.
      this.#waiting.delete(key);
      this.#owed.set(key, { kind: 'raise', ferret, question });
      throw error;
    }
  }

  /** That exact question is over (answered, retired by the transcript or withdrawn): its card is closed. */
  async close(ferret: string, toolUseId: string, reason: CloseReason): Promise<void> {
    await this.#closeEntry(questionEntry(ferret, toolUseId), reason);
  }

  async #closeEntry(entry: EntryId, reason: CloseReason): Promise<void> {
    // Whatever was owed to raise for it is moot now.
    this.#owed.delete(`raise:${entry}`);
    this.#waiting.delete(`raise:${entry}`);
    try {
      for (const ask of await this.asks.open({ source: QUESTION_SOURCE, entry, state: 'open' }))
        await this.asks.close({ ferret: ask.ferret ?? '', id: ask.id }, reason, entry);
      this.#owed.delete(`close:${entry}`);
    } catch (error) {
      this.#owed.set(`close:${entry}`, { kind: 'close', entry, reason });
      throw error;
    }
  }

  /** Tries again what failed before; cheap (nothing is read) when nothing is owed. A failure stays owed. */
  async settle(): Promise<void> {
    for (const [key, owed] of [...this.#owed]) {
      // A board that said "full" is asked again when it changes, not on every look.
      if (this.#waiting.has(key)) continue;
      try {
        if (owed.kind === 'raise') await this.raise(owed.ferret, owed.question);
        else await this.#closeEntry(owed.entry, owed.reason);
      } catch {
        // Still owed; the next look tries again.
      }
    }
  }

  /** The board changed (an item was answered or closed): what it refused for now is asked again, once. */
  async retryWaiting(): Promise<void> {
    if (this.#waiting.size === 0) return;
    for (const key of [...this.#waiting]) {
      const owed = this.#owed.get(key);
      if (owed?.kind !== 'raise') {
        this.#waiting.delete(key);
        continue;
      }
      try {
        // Refused for now again, it stays waiting and says nothing a second time (it is still in `#waiting`).
        await this.raise(owed.ferret, owed.question);
      } catch {
        // Asks could not be reached: it stays owed, and the next look tries again.
      }
    }
  }

  /**
   * Makes the Agenda say what the stored questions say: every stored question has its card (idempotently), and a card
   * of this source whose question is no longer stored (a clear that never reached Asks, a crash between the two) is
   * closed. `stored` is the question each ferret holds NOW, read without failure: an unreadable file is the caller's to
   * refuse, never "no question", or every card would be closed. Throws when Asks cannot be read or written.
   */
  async reconcile(stored: ReadonlyMap<string, Question>): Promise<void> {
    const wanted = new Set<string>();
    for (const [ferret, question] of stored) wanted.add(questionEntry(ferret, question.toolUseId));
    const open: readonly AskSummary[] = await this.asks.open({ source: QUESTION_SOURCE, state: 'open' });
    for (const ask of open) {
      if (wanted.has(ask.entry)) continue;
      await this.asks.close({ ferret: ask.ferret ?? '', id: ask.id }, 'withdrawn', ask.entry);
    }
    for (const [ferret, question] of stored) await this.raise(ferret, question);
  }
}
