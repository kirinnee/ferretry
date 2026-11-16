import type { AskedQuestionFile, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { Question } from '../../../contract/index.ts';
import type { PendingQuestion } from '../../seams/protocol.ts';
import type { TranscriptEvent } from '../../seams/transcript-types.ts';
import { parseAskedQuestion } from './asked.ts';
import { projectStructuredQuestion } from './projection.ts';

/** How often the roster is looked at for a question the hook recorded (the plan's 2 s cadence). */
export const QUESTION_WATCH_MS = 2_000;

/** One ferret as the watch sees it: only a Claude Code ferret that is working or idle can be asking. */
export interface WatchedFerret {
  readonly id: string;
  readonly harness: string;
  readonly state: string;
}

/** The part of a ferret's harness seam the watch reads. Both are reads: nothing is typed. */
export interface WatchedHarness {
  askedQuestion?(): Promise<AskedQuestionFile | undefined>;
  readonly transcript: { read(after?: string, limit?: number): Promise<readonly TranscriptEntry[]> };
}

export interface QuestionWatchDeps {
  /** Every ferret, with its harness key and state. */
  roster(): Promise<readonly WatchedFerret[]>;
  harness(ferret: string): Promise<WatchedHarness | undefined>;
  /** `question.json` as it stands. */
  current(ferret: string): Promise<Question | undefined>;
  /**
   * The tool id the answered stamp (`question-answered.json`) names: the last question an answer visibly landed on. A
   * payload or a stored question for that id is over whatever the transcript has caught up to (v4's answered-stamp
   * reconciliation); `undefined` when none was answered. A read that fails throws, and decides nothing.
   */
  lastAnswered(ferret: string): Promise<string | undefined>;
  /** The one writer (`writeAskedQuestion`): the question stored, or `undefined` when the payload cannot be stored whole. */
  write(
    ferret: string,
    payload: string,
    askedAt: AskedQuestionFile['writtenAt'],
    transcript: string | undefined,
  ): Promise<Question | undefined>;
  /** The exact-id clear (`clearAskedQuestion`). */
  clear(ferret: string, toolUseId: string): Promise<void>;
  asked(ferret: string, toolUseId: string): Promise<void>;
  answered(ferret: string, toolUseId: string): Promise<void>;
  /**
   * Codex's half. Its `request_user_input` call is in the transcript while the form is open (no hook file): the tail of the
   * ferret's own proved transcript as parsed events; `'unreadable'` when it cannot be read (then nothing is decided);
   * `undefined` for a ferret that is not a Codex one (its hook file is read instead). Absent: Codex is not watched.
   */
  transcriptEvents?(ferret: string, limit?: number): Promise<readonly TranscriptEvent[] | 'unreadable' | undefined>;
  /**
   * The one writer for a question the transcript projected (it has no hook payload): stored whole, or `undefined`.
   * `askedAt` is the call's own time, or absent when the event carried none (the writer stamps the instant it saw it).
   */
  writeProjected?(ferret: string, pending: PendingQuestion, askedAt: string | undefined): Promise<Question | undefined>;
}

/** How many of a Codex transcript's newest events a look projects (the open call is among the newest). */
export const QUESTION_TAIL_EVENTS = 200;
/**
 * The wider read made once, only for a stored question whose call AND result are both outside the newest
 * {@link QUESTION_TAIL_EVENTS}: it looks for the exact ids further back before deciding anything.
 */
export const QUESTION_DEEP_EVENTS = 2_000;

const callsTool = (event: TranscriptEvent, toolUseId: string): boolean =>
  event.kind === 'tool-call' && event.call.id === toolUseId;
const resultsTool = (event: TranscriptEvent, toolUseId: string): boolean =>
  event.kind === 'tool-result' && event.result.callId === toolUseId;

/** The harness whose asking leaves a hook file: Claude Code's. */
const CLAUDE_CODE = 'claude-code';
/** The harness whose asking is read from its transcript: Codex's `request_user_input`. */
const CODEX = 'codex';

/** How many looks store one payload before a state store that keeps failing is left alone (looks are 2 s apart). */
const WRITE_ATTEMPTS = 5;

/** Whether the entry made this call or carries its result, by id (the harness reader puts the ids in `entry.tools`). */
function namesTool(entry: TranscriptEntry, toolUseId: string): boolean {
  return (entry.tools?.calls?.includes(toolUseId) ?? false) || (entry.tools?.results?.includes(toolUseId) ?? false);
}

/**
 * Whether the transcript says the question is over: an entry names the call or its result by id (exactly: the id is a
 * field of the entry, never searched for in prose), or holds any event newer than the question.
 */
function endedBy(entries: readonly TranscriptEntry[], toolUseId: string, askedAtMs: number): boolean {
  return entries.some(entry => {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at > askedAtMs) return true;
    return namesTool(entry, toolUseId);
  });
}

/**
 * THE QUESTION WATCH: sees the question Claude Code's hook recorded and makes it `question.json`, and retires it when the
 * transcript says it was answered. The app, the agenda and the Console read `question.json`; this is the only thing that
 * puts a question there. Nothing is typed: it reads the hook's file and the transcript.
 *
 * - A payload is stored once (by its text, per ferret): the hook leaves the file after the form is answered, so a payload
 *   already stored, answered or refused is not stored again. A payload the transcript already names, or that is older than
 *   a transcript event, is a question that is over (a daemon restart meets that file again) and is never shown.
 * - A transcript that cannot be read decides nothing: the payload is looked at again at the next look.
 * - Looks are serial per ferret, so a slow transcript read never overlaps itself.
 */
export class QuestionWatch {
  readonly #seen = new Map<string, string>();
  /** A payload whose write failed, and how many looks have tried it (bounded by {@link WRITE_ATTEMPTS}). */
  readonly #failed = new Map<string, { readonly payload: string; readonly attempts: number }>();
  readonly #looking = new Map<string, Promise<void>>();

  constructor(private readonly deps: QuestionWatchDeps) {}

  /** One look at every ferret that can be asking. A ferret whose look fails is skipped; the others are still looked at. */
  async sweep(): Promise<void> {
    const roster = await this.deps.roster();
    for (const ferret of roster) {
      if (
        (ferret.harness !== CLAUDE_CODE && !(ferret.harness === CODEX && this.deps.transcriptEvents !== undefined)) ||
        (ferret.state !== 'working' && ferret.state !== 'idle')
      )
        continue;
      await this.look(ferret.id).catch(() => undefined);
    }
  }

  /** One look at one ferret, after any look already running for it. */
  async look(ferret: string): Promise<void> {
    const previous = this.#looking.get(ferret) ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(async () => await this.#lookNow(ferret));
    this.#looking.set(ferret, mine);
    try {
      await mine;
    } finally {
      if (this.#looking.get(ferret) === mine) this.#looking.delete(ferret);
    }
  }

  /** The ferret stopped or went away: what was stored for it is forgotten, so a revive's old file is read afresh. */
  forget(ferret: string): void {
    this.#seen.delete(ferret);
    this.#failed.delete(ferret);
  }

  async #lookNow(ferret: string): Promise<void> {
    if ((await this.#codex(ferret)) === 'handled') return;
    const harness = await this.deps.harness(ferret);
    if (harness === undefined) return;
    const open = await this.deps.current(ferret);
    // Read before the file, so a stamp written in between can only make a question over, never bring one back.
    const stamped = await this.deps.lastAnswered(ferret);
    if (
      open !== undefined &&
      (open.toolUseId === stamped || (await this.#over(harness, open.toolUseId, Date.parse(open.askedAt))) === true)
    ) {
      await this.deps.clear(ferret, open.toolUseId);
      await this.deps.answered(ferret, open.toolUseId);
    }
    const file = await harness.askedQuestion?.();
    if (file === undefined || this.#seen.get(ferret) === file.payload) return;
    const parsed = parseAskedQuestion(file.payload, Date.parse(file.writtenAt), file.transcript);
    if (parsed !== undefined) {
      // A form an answer already landed on: the hook leaves its file behind, so it is never stored again.
      if (parsed.toolUseId === stamped) {
        this.#seen.set(ferret, file.payload);
        return;
      }
      const over = await this.#over(harness, parsed.toolUseId, parsed.askedAtMs);
      // Unreadable: decide nothing, look again. Over: a question that is gone, never shown.
      if (over === undefined) return;
      if (over) {
        this.#seen.set(ferret, file.payload);
        return;
      }
    }
    // The payload is remembered only once the write has landed: a transient state failure leaves it unseen, so the next
    // look stores it. A payload that keeps failing is retried a bounded number of looks, then left (a forget or a new
    // payload starts it afresh), so a broken store is not hammered forever. Publishing is separate: it runs after the
    // payload is remembered, so a publish failure never writes (or announces) the question a second time.
    try {
      const stored = await this.deps.write(ferret, file.payload, file.writtenAt, file.transcript);
      this.#seen.set(ferret, file.payload);
      this.#failed.delete(ferret);
      if (stored !== undefined) await this.deps.asked(ferret, stored.toolUseId);
    } catch (error) {
      if (this.#seen.get(ferret) === file.payload) throw error;
      const previous = this.#failed.get(ferret);
      const attempts = (previous?.payload === file.payload ? previous.attempts : 0) + 1;
      if (attempts >= WRITE_ATTEMPTS) {
        this.#seen.set(ferret, file.payload);
        this.#failed.delete(ferret);
      } else this.#failed.set(ferret, { payload: file.payload, attempts });
      throw error;
    }
  }

  /**
   * A Codex ferret's look: the transcript IS the evidence. The open call is stored once; it is retired by the call's own
   * result (the only release a tail carries: a turn event is not one), or by the answered stamp. A transcript that cannot
   * be read decides nothing. `'skip'` means this is not a Codex ferret (or the half is not mounted), so the hook path runs.
   */
  async #codex(ferret: string): Promise<'handled' | 'skip'> {
    const read = this.deps.transcriptEvents;
    const write = this.deps.writeProjected;
    if (read === undefined || write === undefined) return 'skip';
    const events = await read(ferret);
    if (events === undefined) return 'skip';
    if (events === 'unreadable') return 'handled';
    const open = await this.deps.current(ferret);
    const stamped = await this.deps.lastAnswered(ferret);
    const projection = projectStructuredQuestion(events);
    const pending = projection.kind === 'pending' ? projection.question : undefined;
    const over =
      open !== undefined &&
      (open.toolUseId === stamped ||
        (projection.kind === 'resolved' && projection.toolUseId === open.toolUseId) ||
        (pending !== undefined && pending.toolUseId !== open.toolUseId) ||
        (await this.#codexReleased(ferret, open.toolUseId, events)));
    if (over) {
      await this.deps.clear(ferret, open.toolUseId);
      await this.deps.answered(ferret, open.toolUseId);
    }
    if (pending === undefined || pending.toolUseId === stamped) return 'handled';
    if (!over && open?.toolUseId === pending.toolUseId) return 'handled';
    const key = `codex:${pending.toolUseId}`;
    if (this.#seen.get(ferret) === key) return 'handled';
    try {
      const stored = await write(ferret, pending, pending.askedAt);
      this.#seen.set(ferret, key);
      this.#failed.delete(ferret);
      if (stored !== undefined) await this.deps.asked(ferret, stored.toolUseId);
    } catch (error) {
      if (this.#seen.get(ferret) === key) throw error;
      const previous = this.#failed.get(ferret);
      const attempts = (previous?.payload === key ? previous.attempts : 0) + 1;
      if (attempts >= WRITE_ATTEMPTS) {
        this.#seen.set(ferret, key);
        this.#failed.delete(ferret);
      } else this.#failed.set(ferret, { payload: key, attempts });
      throw error;
    }
    return 'handled';
  }

  /**
   * Whether the transcript positively releases the STORED question, independently of the projector's one final pick (a
   * result whose call left the newest tail, or an earlier question's result behind a later question, projects to none):
   *
   * 1. its exact tool-result is among the events: released;
   * 2. its exact call is among them with no result: still open (a turn event is never release evidence);
   * 3. neither, and the tail is not full: the transcript simply does not say, so nothing is decided;
   * 4. neither, and the tail is full: a wider read looks for the same ids; a result there releases, a call there keeps
   *    it, and a FULL wide read holding neither means the call is more than {@link QUESTION_DEEP_EVENTS} events old.
   *    An open form writes no such run of events, so that too is a positive release.
   *
   * An unreadable wide read decides nothing.
   */
  async #codexReleased(ferret: string, toolUseId: string, events: readonly TranscriptEvent[]): Promise<boolean> {
    if (events.some(event => resultsTool(event, toolUseId))) return true;
    if (events.some(event => callsTool(event, toolUseId))) return false;
    if (events.length < QUESTION_TAIL_EVENTS) return false;
    const wide = await this.deps.transcriptEvents?.(ferret, QUESTION_DEEP_EVENTS);
    if (wide === undefined || wide === 'unreadable') return false;
    if (wide.some(event => resultsTool(event, toolUseId))) return true;
    if (wide.some(event => callsTool(event, toolUseId))) return false;
    return wide.length >= QUESTION_DEEP_EVENTS;
  }

  /** `true` the question is over, `false` still open, `undefined` the transcript could not be read. */
  async #over(harness: WatchedHarness, toolUseId: string, askedAtMs: number): Promise<boolean | undefined> {
    const entries = await harness.transcript.read().then(
      read => read,
      () => undefined,
    );
    return entries === undefined ? undefined : endedBy(entries, toolUseId, askedAtMs);
  }
}
