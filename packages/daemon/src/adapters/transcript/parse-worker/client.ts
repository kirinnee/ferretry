/**
 * THE EVENT LOOP'S SIDE OF THE TRANSCRIPT PARSE WORKER: thin proxies that ask a thread and fall back to
 * the very reader that thread would have run.
 *
 * ONE THREAD, SHARED. {@link TranscriptParseWorker} owns the bundled worker (`bin/transcript-parse.worker.ts`)
 * and the conversation described in `protocol.ts`; every proxy below asks through it, so a read, a
 * window step, a conversation's rows, an image proof and a listing row all queue on one thread started on demand and ended
 * when idle. The worker answers in pages, and this side puts an answer back together from the pages
 * that arrived under its id.
 *
 * CORRECTNESS NEVER DEPENDS ON THE WORKER. A proxy is built with the inline reader it stands for, and
 * asks that reader instead whenever the worker is retired or backing off after a failure: the same
 * code, run here, costing the loop what it cost before the worker existed. A thread that errors or
 * stalls refuses what it held, exactly as a read that raised on the loop would have.
 *
 * Nothing here parses: the proxies carry plain data both ways and never import a reader's
 * implementation, so the loop gains no new weight and the worker remains the one place a parse runs.
 */

import { parseTranscriptImageHandle } from '@ferretry/protocol/transcript-images';
import type { ConversationDescriber } from '../../../lib/imports/conversation-describer.ts';
import { type HandoffScope, NO_HANDOFF_SCOPE } from '../../../lib/imports/conversation-text.ts';
import type { ForeignTranscriptReader } from '../../../lib/imports/foreign-history.ts';
import {
  type ConversationDigestFailure,
  ConversationDigestError,
  type PortableConversationRow,
} from '../../../lib/session/transcript/digest.ts';
import {
  type TranscriptImageFailure,
  TranscriptImageError,
  type TranscriptImageLocator,
  type TranscriptImageLookup,
  type TranscriptImageTarget,
  type TranscriptImages,
} from '../../../lib/session/transcript/image-reader.ts';
import type { TranscriptRowsIndex, TranscriptTarget } from '../../../lib/session/transcript/reader.ts';
import type {
  TranscriptBatch,
  TranscriptFollowOptions,
  TranscriptHarness,
  TranscriptReadOptions,
  TranscriptSource,
  TranscriptWindow,
  TranscriptWindowOptions,
  TranscriptWindowStep,
} from '../../../lib/transcript/types.ts';
import { bundledWorkerUrl } from '../../runtime/bundled-worker.ts';
import {
  BundledWorkerHost,
  type HostedAnswer,
  type HostedWorker,
  type WorkerRestartPolicy,
} from '../../runtime/bundled-worker-host.ts';
import { LoadSafeWorker } from '../../runtime/load-safe-worker.ts';
import {
  type JoinedPages,
  joinPage,
  startJoin,
  type TranscriptBatchShell,
  type TranscriptParseGreeting,
  type TranscriptParseRequest,
  type TranscriptParseResponse,
  type TranscriptParseValue,
} from './protocol.ts';

/** The part of a Worker this adapter uses, so a test can stand in a thread that misbehaves on cue. */
export type TranscriptParseThread = HostedWorker<
  TranscriptParseRequest | TranscriptParseGreeting,
  TranscriptParseResponse
>;

/** What tells the worker, once, that the proxy it was opened for is gone: `FinalizationRegistry`'s part. */
export interface WindowRegistry {
  register(target: object, held: number): void;
}

/** One question to the worker, before its id is chosen. */
type Question =
  Extract<TranscriptParseRequest, { readonly id: number }> extends infer Each
    ? Each extends unknown
      ? Omit<Each, 'id'>
      : never
    : never;

/** An answer: its value, and its pages, joined as they arrived before it. */
export interface TranscriptParseAnswer {
  readonly value: TranscriptParseValue;
  readonly joined: JoinedPages;
}

export interface TranscriptParseWorkerOptions {
  /** Where an import listing may read a hand-off pointer's document from; sent to every new thread. */
  readonly handoffScope?: HandoffScope;
  /** How long one request may take before the thread is presumed stuck and replaced. */
  readonly timeoutMs?: number;
  readonly restart?: WorkerRestartPolicy;
  readonly spawn?: () => TranscriptParseThread;
  /** Told once, when failures retire the worker and every proxy turns to its inline reader for good. */
  readonly retired?: () => void;
  readonly now?: () => number;
  /** How a dropped window is noticed; the default is a `FinalizationRegistry`. */
  readonly registry?: (release: (held: number) => void) => WindowRegistry;
}

const spawnBundled = (): TranscriptParseThread =>
  new LoadSafeWorker(bundledWorkerUrl('transcript-parse'), { type: 'module' });

const DEFAULT_RESTART: WorkerRestartPolicy = {
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
  maxFailures: 5,
  windowMs: 10 * 60_000,
};

/** How long an idle thread is kept when it holds no window. */
const PARSE_IDLE_MS = 30_000;
/** How long an idle thread is kept while a window is open: the thread IS the window's memory. */
const PARSE_WINDOW_HOLD_MS = 6 * 60 * 60_000;

/**
 * The value a refusal is raised as: an image or digest refusal keeps its failure and its class, so the
 * route restates it — an operator is told a transcript is damaged only when the fold said it was.
 */
function refusalError(refusal: {
  readonly message: string;
  readonly imageFailure?: TranscriptImageFailure;
  readonly digestFailure?: ConversationDigestFailure;
}): Error {
  if (refusal.imageFailure !== undefined) return new TranscriptImageError(refusal.imageFailure, refusal.message);
  if (refusal.digestFailure !== undefined) return new ConversationDigestError(refusal.digestFailure, refusal.message);
  return new Error(refusal.message);
}

/** A request's answer, its refusal — or nothing, for a page and a probe reply. */
function answerOf(response: TranscriptParseResponse): HostedAnswer<TranscriptParseValue> | undefined {
  if (!('ok' in response)) return undefined;
  return response.ok
    ? { id: response.id, ok: true, value: response.value }
    : { id: response.id, ok: false, error: refusalError(response.refusal) };
}

/**
 * The one transcript parse thread: asked by request, answered by id, and put back together from pages.
 * Restarts back off (1 s, doubling to 30 s) and five failures in ten minutes retire it until the daemon
 * restarts; {@link available} says whether a proxy may ask.
 */
export class TranscriptParseWorker {
  readonly #host: BundledWorkerHost<
    TranscriptParseRequest | TranscriptParseGreeting,
    TranscriptParseResponse,
    TranscriptParseValue
  >;
  /** What has arrived of each request in flight, by id; an entry exists exactly while its request does. */
  readonly #pages = new Map<number, JoinedPages>();
  /** The windows a proxy holds open, by number. */
  readonly #held = new Set<number>();
  readonly #registry: WindowRegistry;
  #window = 1;

  constructor(options: TranscriptParseWorkerOptions = {}) {
    const handoffScope = options.handoffScope ?? NO_HANDOFF_SCOPE;
    this.#host = new BundledWorkerHost({
      label: 'the transcript worker',
      spawn: options.spawn ?? spawnBundled,
      answer: answerOf,
      other: message => {
        if (!('page' in message)) return;
        const joined = this.#pages.get(message.id);
        if (joined !== undefined) joinPage(joined, message.page);
      },
      greeting: () => ({ op: 'configure', handoffScope }),
      timeoutMs: options.timeoutMs ?? 120_000,
      idleMs: () => (this.#held.size > 0 ? PARSE_WINDOW_HOLD_MS : PARSE_IDLE_MS),
      restart: options.restart ?? DEFAULT_RESTART,
      ...(options.retired === undefined ? {} : { retired: options.retired }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const release = (held: number): void => this.release(held);
    this.#registry = options.registry?.(release) ?? finalizing(release);
  }

  /** Whether a request may be sent now: the worker is neither retired nor backing off. */
  get available(): boolean {
    return this.#host.available;
  }

  /** How many requests the thread holds right now: the queue depth a performance profile samples. */
  get inFlight(): number {
    return this.#host.inFlight;
  }

  /** Asks the thread `question` and resolves with its value and the pages that came before it. */
  async ask(question: Question, what: string): Promise<TranscriptParseAnswer> {
    const id = this.#host.nextId();
    this.#pages.set(id, startJoin());
    try {
      const value = await this.#host.request(id, { ...question, id } as TranscriptParseRequest, what);
      return { value, joined: this.#pages.get(id) ?? startJoin() };
    } finally {
      // Always: a page that arrives after its request settled finds no entry and is dropped.
      this.#pages.delete(id);
    }
  }

  /**
   * A number for a window `target` is about to proxy, held until `target` is collected or released.
   * The thread is kept for as long as any window is held, because it holds the window's position.
   */
  hold(target: object): number {
    const number = this.#window++;
    this.#held.add(number);
    this.#registry.register(target, number);
    return number;
  }

  /** The window is no longer wanted: the thread forgets it. Idempotent, and never starts a thread. */
  release(held: number): void {
    if (this.#held.delete(held)) this.#host.notify({ op: 'window-close', window: held });
  }

  /** Ends the thread and refuses every request still waiting on it. */
  close(): void {
    this.#host.close();
  }
}

/** The default {@link WindowRegistry}: released when the proxy is garbage collected. */
function finalizing(release: (held: number) => void): WindowRegistry {
  return new FinalizationRegistry<number>(release);
}

/** The answer's value, when it is the `kind` this question is answered with. */
function expecting<Kind extends TranscriptParseValue['kind']>(
  answer: TranscriptParseAnswer,
  kind: Kind,
): Extract<TranscriptParseValue, { readonly kind: Kind }> {
  if (answer.value.kind !== kind)
    throw new Error(`the transcript worker answered with ${answer.value.kind}, not ${kind}`);
  return answer.value as Extract<TranscriptParseValue, { readonly kind: Kind }>;
}

/** The batch a shell and its pages make up: `rawRecords` present exactly when the read had them. */
function batchOf(shell: TranscriptBatchShell, joined: JoinedPages): TranscriptBatch {
  const { raw, ...rest } = shell;
  return { ...rest, events: joined.events, ...(raw ? { rawRecords: joined.rawRecords } : {}) };
}

/**
 * A window whose position lives in the worker. Its steps are strictly one at a time, as a window's
 * always were, and the first carries the opening that makes the worker hold the window at all.
 *
 * A WINDOW NEVER RE-OPENS ITSELF. A step the worker can no longer answer for — its thread ended or was
 * replaced, or it evicted the window — is refused (`WINDOW_LOST`) and the consumer opens a new window;
 * only a window's first step opens it. A window whose first step has not been asked when the worker turns
 * unavailable is opened inline instead, so no window waits on a worker that is not coming back.
 */
class WorkerTranscriptWindow implements TranscriptWindow {
  readonly #number: number;
  #tail: Promise<unknown> = Promise.resolve();
  #opened = false;
  #inline: TranscriptWindow | undefined;

  constructor(
    private readonly worker: TranscriptParseWorker,
    private readonly source: TranscriptSource,
    readonly file: string,
    private readonly options: TranscriptWindowOptions,
  ) {
    this.#number = worker.hold(this);
  }

  next(): Promise<TranscriptWindowStep> {
    // The tail never rejects, so a refused step does not stop the one behind it from being asked.
    const step = this.#tail.then(() => this.#step());
    this.#tail = step.catch(() => undefined);
    return step;
  }

  async #step(): Promise<TranscriptWindowStep> {
    if (this.#inline === undefined && !this.#opened && !this.worker.available) {
      this.#inline = this.source.window(this.file, this.options);
      this.worker.release(this.#number);
    }
    if (this.#inline !== undefined) return await this.#inline.next();
    // The opening travels with the FIRST step and with no other, even a first step that failed: a window
    // opened again from its options in a thread that never held it would answer from the start of the
    // file, records its consumer has already folded, and say nothing of it.
    // `raw: false`: the records stay in the worker (see WorkerTranscriptSource).
    const opening = this.#opened
      ? {}
      : { open: { harness: this.source.harness, file: this.file, options: this.options, raw: false } };
    this.#opened = true;
    try {
      const answer = await this.worker.ask(
        { op: 'window-next', window: this.#number, ...opening },
        `step ${this.file}`,
      );
      const step = expecting(answer, 'step');
      return { ...(step.batch === undefined ? {} : { batch: batchOf(step.batch, answer.joined) }), more: step.more };
    } catch (error) {
      // A step that failed leaves the window gone from the worker, whatever the reason: it is not held.
      this.worker.release(this.#number);
      throw error;
    }
  }
}

/**
 * A {@link TranscriptSource} whose reads and windows run on the worker, falling back to `inline` — the
 * `NodeTranscriptSource` for the same harness — when the worker is not available. A live `follow` is
 * the loop's own: it is a watcher, not a parse.
 *
 * A WINDOW'S STEPS CARRY NO RAW RECORDS. Raw records are the file's own bytes — a window stepped to
 * the end of a 100 MB transcript moved 100 MB between threads for them — and the one consumer that
 * binds evidence to a window's records, the conversation index, folds in the worker
 * ({@link WorkerConversationIndex}). So a proxy window opens with `raw: false` and its batches have no
 * `rawRecords`: the `TranscriptBatch` contract's "a batch without them", which a consumer that needs
 * record-exact evidence refuses rather than reconstructs. A `read` keeps them, because a digest binds
 * its selection to the records of one complete read. A window opened inline — the worker was not
 * available — is the inline source's own and carries them as it always did.
 */
export class WorkerTranscriptSource implements TranscriptSource {
  constructor(
    readonly harness: TranscriptHarness,
    private readonly worker: TranscriptParseWorker,
    private readonly inline: TranscriptSource,
  ) {}

  async read(file: string, options?: TranscriptReadOptions): Promise<TranscriptBatch> {
    if (!this.worker.available) return await this.inline.read(file, options);
    const answer = await this.worker.ask(
      { op: 'read', harness: this.harness, file, options: options ?? {} },
      `read ${file}`,
    );
    return batchOf(expecting(answer, 'batch').batch, answer.joined);
  }

  follow(file: string, options?: TranscriptFollowOptions): AsyncIterable<TranscriptBatch> {
    return this.inline.follow(file, options);
  }

  window(file: string, options: TranscriptWindowOptions): TranscriptWindow {
    if (!this.worker.available) return this.inline.window(file, options);
    return new WorkerTranscriptWindow(this.worker, this.inline, file, options);
  }
}

/** What {@link WorkerTranscriptImages} falls back to: the reader that locates and proves on this thread. */
export interface InlineTranscriptImages extends TranscriptImages {
  lookupAt(sessionId: string, handleText: string, target: TranscriptImageTarget): Promise<TranscriptImageLookup>;
}

/**
 * The image route's reader: the session is located HERE (the loop owns the session registry) and the
 * proof — reading and parsing the record the handle names — runs on the worker. A handle that is not
 * one, a session without a transcript, and an unavailable worker are all the inline reader's to refuse
 * or answer, so every refusal reads as it always did.
 */
export class WorkerTranscriptImages implements TranscriptImages {
  constructor(
    private readonly worker: TranscriptParseWorker,
    private readonly locator: TranscriptImageLocator,
    private readonly inline: InlineTranscriptImages,
  ) {}

  async lookup(sessionId: string, handleText: string): Promise<TranscriptImageLookup> {
    if (!this.worker.available || parseTranscriptImageHandle(handleText) === undefined)
      return await this.inline.lookup(sessionId, handleText);
    const target = await this.locator.locate(sessionId);
    if (target === undefined) return await this.inline.lookup(sessionId, handleText);
    const proved = expecting(await this.#ask(sessionId, handleText, target, false), 'image');
    return {
      etag: proved.etag,
      image: proved.image,
      download: async () => {
        if (!this.worker.available) return await (await this.inline.lookupAt(sessionId, handleText, target)).download();
        const again = expecting(await this.#ask(sessionId, handleText, target, true), 'image');
        if (again.base64 === undefined) throw new Error('the transcript worker answered a download without its bytes');
        return { image: again.image, base64: again.base64 };
      },
    };
  }

  async #ask(sessionId: string, handle: string, target: TranscriptImageTarget, download: boolean) {
    return await this.worker.ask({ op: 'image', sessionId, handle, target, download }, `read image ${handle}`);
  }
}

/** A foreign transcript's row and events, read on the worker; the inline reader answers when it cannot. */
export class WorkerForeignTranscriptReader implements ForeignTranscriptReader {
  constructor(
    private readonly worker: TranscriptParseWorker,
    private readonly inline: ForeignTranscriptReader,
  ) {}

  async read(
    candidate: Parameters<ForeignTranscriptReader['read']>[0],
    withEvents: boolean,
  ): ReturnType<ForeignTranscriptReader['read']> {
    if (!this.worker.available) return await this.inline.read(candidate, withEvents);
    const answer = await this.worker.ask({ op: 'foreign', candidate, withEvents }, `read ${candidate.source}`);
    if (answer.value.kind === 'foreign-skipped') return { reason: answer.value.reason };
    return { conversation: expecting(answer, 'foreign').conversation, events: answer.joined.events };
  }
}

/**
 * Every session's portable conversation rows, folded and held by the `ConversationIndex` in the worker:
 * the rows cross, the raw records they are chained over never do.
 *
 * `inline` is a `ConversationIndex` of the loop's own, over the INLINE sources — never over the proxy
 * sources, whose windows carry no raw records and would make every fold refuse. It answers whenever
 * the worker is not available, and keeps its own folds: the two never share a fold, so neither can
 * extend rows the other read. A digest refusal from the worker is raised as the
 * `ConversationDigestError` it was, so an operator is told why the conversation could not be read.
 */
export class WorkerConversationIndex implements TranscriptRowsIndex {
  constructor(
    private readonly worker: TranscriptParseWorker,
    private readonly inline: TranscriptRowsIndex,
  ) {}

  async rows(target: TranscriptTarget, file: string): Promise<readonly PortableConversationRow[] | undefined> {
    if (!this.worker.available) return await this.inline.rows(target, file);
    // Only the two facts the index reads: a caller's richer target object need not be cloneable.
    const asked = { sessionId: target.sessionId, harness: target.harness };
    const answer = await this.worker.ask({ op: 'rows', target: asked, file }, `fold ${file}`);
    if (expecting(answer, 'rows').unspoken === true) return undefined;
    return answer.joined.rows;
  }
}

/** An import listing's row and preview, described on the worker; the inline describer answers when it cannot. */
export class WorkerConversationDescriber implements ConversationDescriber {
  constructor(
    private readonly worker: TranscriptParseWorker,
    private readonly inline: ConversationDescriber,
  ) {}

  async describe(candidate: Parameters<ConversationDescriber['describe']>[0]) {
    if (!this.worker.available) return await this.inline.describe(candidate);
    const answer = await this.worker.ask({ op: 'describe', candidate }, `describe ${candidate.source}`);
    return expecting(answer, 'described').described;
  }

  async preview(candidate: Parameters<ConversationDescriber['preview']>[0]) {
    if (!this.worker.available) return await this.inline.preview(candidate);
    const answer = await this.worker.ask({ op: 'preview', candidate }, `preview ${candidate.source}`);
    return expecting(answer, 'preview').preview;
  }
}
