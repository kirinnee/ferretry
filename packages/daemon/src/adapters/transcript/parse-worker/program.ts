/**
 * THE TRANSCRIPT PARSE THREAD'S WHOLE PROGRAM: it answers the questions the event loop would otherwise
 * answer by parsing a transcript itself.
 *
 * Its own module, not the worker's entry file, so the same program can be served over a fake scope in a
 * test; `bin/transcript-parse.worker.ts` only serves it. It runs the very readers the loop runs —
 * `NodeTranscriptSource`, the `ConversationIndex`, `TranscriptImageReader`, the history and import
 * listings' file readers — so moving a read here changes where it costs, never what it answers. `protocol.ts` is the whole of the
 * conversation and says why an answer travels in pages.
 *
 * WHAT IS HELD between requests is only what a request needs a later one to find: the windows it opened
 * (an append-only read remembers its byte offset, so a step must reach the window the last step left),
 * every session's folded conversation (the index extends a fold by what was appended), the image
 * reader's proofs, and the import listing's description cache. Losing the thread loses none of it for
 * good: a step for a window the thread no longer holds is refused as {@link WINDOW_LOST} and its
 * consumer opens it again, and a new thread's index folds each session again from byte zero.
 *
 * THE CONVERSATION INDEX IS HERE BECAUSE ITS INPUT IS EVERY RAW BYTE. Its rows are chained over each
 * physical record of the file, so folding it anywhere else moved the whole transcript between threads
 * and hashed it on the event loop. Here it reads, hashes and holds, and only the rows cross. It is the
 * very `ConversationIndex` the loop would run, over the very sources, so every row's chain, point and
 * text is what the loop would have folded from the same bytes.
 *
 * KEPT LEAN ON PURPOSE. This thread's cost is the modules it loads, once, for as long as the daemon
 * lives, so it imports direct module paths and protocol subpaths — never `src/lib/index.ts`, the adapter
 * barrels or the `@ferretry/protocol` barrel, which load the whole daemon.
 */
import { NO_HANDOFF_SCOPE, type HandoffScope } from '../../../lib/imports/conversation-text.ts';
import type { ConversationDescriber } from '../../../lib/imports/conversation-describer.ts';
import { FileConversationDescriber } from '../../../lib/imports/conversation-describer.ts';
import type { ForeignTranscriptReader } from '../../../lib/imports/foreign-history.ts';
import { FileForeignTranscriptReader } from '../../../lib/imports/foreign-history.ts';
import { ConversationIndex } from '../../../lib/session/transcript/conversation-index.ts';
import { ConversationDigestError } from '../../../lib/session/transcript/digest.ts';
import {
  TranscriptImageError,
  TranscriptImageReader,
  type TranscriptImageLookup,
  type TranscriptImageTarget,
} from '../../../lib/session/transcript/image-reader.ts';
import type { TranscriptRowsIndex } from '../../../lib/session/transcript/reader.ts';
import { ClaudeTranscriptParser } from '../../../lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../lib/transcript/codex.ts';
import { PacedTranscriptParser } from '../../../lib/transcript/sliced.ts';
import type {
  TranscriptBatch,
  TranscriptHarness,
  TranscriptSource,
  TranscriptWindow,
} from '../../../lib/transcript/types.ts';
import { NodeConversationFiles } from '../../imports/node-conversation-file-reader.ts';
import { NodeForeignHistoryFiles } from '../../imports/node-foreign-history-files.ts';
import { LOOP_PARSE_PACING, NodeTranscriptFileRuntime, NodeTranscriptSource } from '../file-source.ts';
import { NodeTranscriptImageFiles } from '../image-files.ts';
import {
  type OutgoingPage,
  pagesOf,
  rowPagesOf,
  type TranscriptBatchShell,
  type TranscriptParseGreeting,
  type TranscriptParseProbe,
  type TranscriptParseRefusal,
  type TranscriptParseRequest,
  type TranscriptParseResponse,
  type TranscriptParseValue,
  WINDOW_LOST,
} from './protocol.ts';

/** How many windows the thread holds at once; opening one more forgets the one stepped least recently. */
export const MAX_HELD_WINDOWS = 512;

/** The part of a worker's global scope the program uses. */
export interface TranscriptParseScope {
  onmessage:
    | ((event: MessageEvent<TranscriptParseRequest | TranscriptParseGreeting | TranscriptParseProbe>) => void)
    | null;
  postMessage(message: TranscriptParseResponse, transfer?: ArrayBuffer[]): void;
}

/** What the program answers with: every reader is the event loop's own, so the answers are the same. */
export interface TranscriptParseReaders {
  readonly sources: Readonly<Record<TranscriptHarness, Pick<TranscriptSource, 'read' | 'window'>>>;
  readonly images: {
    lookupAt(sessionId: string, handle: string, target: TranscriptImageTarget): Promise<TranscriptImageLookup>;
  };
  readonly foreign: ForeignTranscriptReader;
  /** The conversation index, held for the thread's life: a fold is extended by the next read of it. */
  readonly rows: TranscriptRowsIndex;
  /** A describer reading hand-off documents from `handoffScope`; built when the greeting arrives. */
  readonly describer: (handoffScope: HandoffScope) => ConversationDescriber;
}

/** A batch without the events and raw records that travel in the pages before it. */
function shellOf(batch: TranscriptBatch): TranscriptBatchShell {
  const { events: _events, rawRecords, ...rest } = batch;
  return { ...rest, raw: rawRecords !== undefined };
}

/** A window's steps as they are, but with their raw records left here: the batch says it had none. */
function withoutRaw(window: TranscriptWindow): TranscriptWindow {
  return {
    file: window.file,
    next: async () => {
      const step = await window.next();
      if (step.batch?.rawRecords === undefined) return step;
      const { rawRecords: _rawRecords, ...batch } = step.batch;
      return { ...step, batch };
    },
  };
}

/** What a thrown error is refused with: its message, and an image or digest refusal's failure. */
function refusalOf(error: unknown): TranscriptParseRefusal {
  if (error instanceof TranscriptImageError) return { message: error.message, imageFailure: error.failure };
  if (error instanceof ConversationDigestError) return { message: error.message, digestFailure: error.failure };
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Answers every request `scope` receives, with `readers`. */
export function serveTranscriptParse(scope: TranscriptParseScope, readers: TranscriptParseReaders): void {
  let handoffScope: HandoffScope = NO_HANDOFF_SCOPE;
  let describer: ConversationDescriber | undefined;
  const describing = (): ConversationDescriber => (describer ??= readers.describer(handoffScope));

  // Map order is recency: a step moves its window to the end, and eviction takes the front.
  const windows = new Map<number, TranscriptWindow>();
  // The tail of each window's steps in flight: a step starts when the one before it has answered.
  const stepping = new Map<number, Promise<void>>();

  const post = (response: TranscriptParseResponse, transfer: readonly ArrayBuffer[] = []): void =>
    scope.postMessage(response, [...transfer]);
  const postPages = (id: number, pages: readonly OutgoingPage[]): void => {
    for (const { page, transfer } of pages) post({ id, page }, transfer);
  };
  const batchValue = (id: number, batch: TranscriptBatch): TranscriptBatchShell => {
    postPages(id, pagesOf(batch.events, batch.rawRecords));
    return shellOf(batch);
  };

  const hold = (window: number, held: TranscriptWindow): void => {
    windows.delete(window);
    windows.set(window, held);
    while (windows.size > MAX_HELD_WINDOWS) {
      const oldest = windows.keys().next();
      if (oldest.done === true) return;
      windows.delete(oldest.value);
    }
  };

  const step = async (id: number, request: Extract<TranscriptParseRequest, { op: 'window-next' }>) => {
    const { window: number, open } = request;
    let held = windows.get(number);
    if (held === undefined) {
      if (open === undefined) throw new Error(WINDOW_LOST);
      const opened = readers.sources[open.harness].window(open.file, open.options);
      held = open.raw ? opened : withoutRaw(opened);
    }
    // Held before it is stepped, so a window closed mid-step stays closed.
    hold(number, held);
    let result: Awaited<ReturnType<TranscriptWindow['next']>>;
    try {
      result = await held.next();
    } catch (error) {
      windows.delete(number);
      throw error;
    }
    const batch = result.batch === undefined ? undefined : batchValue(id, result.batch);
    return { kind: 'step', ...(batch === undefined ? {} : { batch }), more: result.more } as const;
  };

  const answer = async (
    request: Exclude<TranscriptParseRequest, { op: 'window-close' }>,
  ): Promise<TranscriptParseValue> => {
    switch (request.op) {
      case 'read': {
        const batch = await readers.sources[request.harness].read(request.file, request.options);
        return { kind: 'batch', batch: batchValue(request.id, batch) };
      }
      case 'window-next':
        return await step(request.id, request);
      case 'image': {
        const found = await readers.images.lookupAt(request.sessionId, request.handle, request.target);
        const base64 = request.download ? (await found.download()).base64 : undefined;
        return { kind: 'image', etag: found.etag, image: found.image, ...(base64 === undefined ? {} : { base64 }) };
      }
      case 'foreign': {
        const read = await readers.foreign.read(request.candidate, request.withEvents);
        if ('reason' in read) return { kind: 'foreign-skipped', reason: read.reason };
        postPages(request.id, pagesOf(read.events));
        return { kind: 'foreign', conversation: read.conversation };
      }
      case 'describe':
        return { kind: 'described', described: await describing().describe(request.candidate) };
      case 'preview':
        return { kind: 'preview', preview: await describing().preview(request.candidate) };
      case 'rows': {
        const rows = await readers.rows.rows(request.target, request.file);
        if (rows === undefined) return { kind: 'rows', unspoken: true };
        postPages(request.id, rowPagesOf(rows));
        return { kind: 'rows' };
      }
    }
  };

  const serve = async (request: Exclude<TranscriptParseRequest, { op: 'window-close' }>): Promise<void> => {
    try {
      post({ id: request.id, ok: true, value: await answer(request) });
    } catch (error) {
      // An answer that could not be posted (not cloneable) is refused like any other failure.
      post({ id: request.id, ok: false, refusal: refusalOf(error) });
    }
  };

  scope.onmessage = ({ data: message }) => {
    if ('probe' in message) return post({ probe: true });
    if (message.op === 'configure') {
      handoffScope = message.handoffScope;
      describer = undefined;
      return;
    }
    if (message.op === 'window-close') {
      windows.delete(message.window);
      return;
    }
    if (message.op !== 'window-next') {
      void serve(message);
      return;
    }
    // Steps of one window never interleave: each starts when the one before it has answered.
    const previous = stepping.get(message.window) ?? Promise.resolve();
    const tail = previous.then(async () => await serve(message));
    stepping.set(message.window, tail);
    void tail.then(() => {
      if (stepping.get(message.window) === tail) stepping.delete(message.window);
    });
  };
}

/** The readers the event loop itself runs, over the real filesystem. */
export function defaultTranscriptParseReaders(): TranscriptParseReaders {
  const claude = new ClaudeTranscriptParser();
  const codex = new CodexTranscriptParser();
  const paced = {
    claude: new PacedTranscriptParser(claude, LOOP_PARSE_PACING),
    codex: new PacedTranscriptParser(codex, LOOP_PARSE_PACING),
  } as const;
  const sources = { claude: new NodeTranscriptSource(claude), codex: new NodeTranscriptSource(codex) } as const;
  return {
    sources,
    rows: new ConversationIndex([sources.claude, sources.codex], new NodeTranscriptFileRuntime(), LOOP_PARSE_PACING),
    // The event loop locates the transcript and sends it; nothing here is asked to find one.
    images: new TranscriptImageReader({ locate: async () => undefined }, new NodeTranscriptImageFiles(), paced),
    foreign: new FileForeignTranscriptReader(new NodeForeignHistoryFiles(), paced),
    describer: handoffScope => new FileConversationDescriber(new NodeConversationFiles(), paced, handoffScope),
  };
}
