/**
 * THE EVENT LOOP'S PROXIES FOR THE TRANSCRIPT PARSE WORKER ANSWER EXACTLY WHAT THE INLINE READERS DO.
 *
 * A scripted thread stands in for the worker, so each case makes it answer in pages, refuse, stall, crash or
 * lose a window on cue. They pin what a consumer relies on: a read and a window step have the very shape
 * the inline reader gives (events, raw records only when the read had them, cursor, issues, reset); steps
 * of one window never overlap; a window is opened by its first step and by no other, so a step after its
 * thread ended is refused rather than re-opened from the start; a worker that is retired or backing off
 * is never asked and the inline reader answers instead.
 */
import { describe, it } from 'bun:test';
import {
  TranscriptImageError,
  type TranscriptImageLookup,
} from '../../../../src/lib/session/transcript/image-reader.ts';
import should from 'should';
import {
  TranscriptParseWorker,
  type TranscriptParseThread,
  type TranscriptParseWorkerOptions,
  WorkerConversationDescriber,
  WorkerConversationIndex,
  WorkerForeignTranscriptReader,
  WorkerTranscriptImages,
  WorkerTranscriptSource,
} from '../../../../src/adapters/transcript/parse-worker/client.ts';
import {
  pagesOf,
  rowPagesOf,
  type TranscriptBatchShell,
  type TranscriptParseGreeting,
  type TranscriptParseRefusal,
  type TranscriptParseRequest,
  type TranscriptParseResponse,
  type TranscriptParseValue,
  WINDOW_LOST,
} from '../../../../src/adapters/transcript/parse-worker/protocol.ts';
import type { ConversationDescriber } from '../../../../src/lib/imports/conversation-describer.ts';
import type { ForeignTranscriptReader } from '../../../../src/lib/imports/foreign-history.ts';
import {
  ConversationDigestError,
  type PortableConversationRow,
} from '../../../../src/lib/session/transcript/digest.ts';
import type { TranscriptRowsIndex } from '../../../../src/lib/session/transcript/reader.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptRawRecord,
  TranscriptSource,
  TranscriptWindow,
} from '../../../../src/lib/transcript/types.ts';

type Sent = TranscriptParseRequest | TranscriptParseGreeting;
type Asked = Extract<Sent, { readonly id: number }>;

/** A thread a test drives: it records what it was sent and answers however the script says. */
class ScriptedThread implements TranscriptParseThread {
  onmessage: ((event: MessageEvent<TranscriptParseResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: Sent[] = [];
  /** The windows this thread holds: what a real worker's map is. */
  readonly windows = new Set<number>();
  terminated = false;

  constructor(private readonly script: (message: Sent, thread: ScriptedThread) => void) {}

  postMessage(message: Sent): void {
    this.sent.push(message);
    queueMicrotask(() => this.script(message, this));
  }

  say(response: TranscriptParseResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<TranscriptParseResponse>);
  }

  /** The answer: its pages in order, then the value. */
  answer(
    id: number,
    value: TranscriptParseValue,
    events: readonly TranscriptEvent[] = [],
    raw: TranscriptRawRecord[] = [],
  ): void {
    for (const { page } of pagesOf(events, raw)) this.say({ id, page });
    this.say({ id, ok: true, value });
  }

  refuse(id: number, refusal: TranscriptParseRefusal): void {
    this.say({ id, ok: false, refusal });
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }

  get asked(): Asked[] {
    return this.sent.filter((each): each is Asked => 'id' in each);
  }
}

const event = (text: string): TranscriptEvent => ({ kind: 'message', text }) as unknown as TranscriptEvent;

const shell = (over: Partial<TranscriptBatchShell> = {}): TranscriptBatchShell => ({
  harness: 'claude',
  file: '/t.jsonl',
  reset: false,
  cursor: { byteOffset: 12, pendingBytes: 0, nextLine: 3 },
  observedInputs: [],
  issues: [],
  raw: false,
  ...over,
});

const raw = (byteOffset: number, text: string): TranscriptRawRecord => ({
  byteOffset,
  bytes: new TextEncoder().encode(text),
});

/** A worker over a scripted thread per spawn; the script sees every request (not the greeting or a window close). */
function worker(
  script: (message: Asked, thread: ScriptedThread) => void,
  options: Partial<TranscriptParseWorkerOptions> = {},
) {
  const threads: ScriptedThread[] = [];
  const parse = new TranscriptParseWorker({
    spawn: () => {
      const thread = new ScriptedThread((message, from) => {
        if ('id' in message) script(message, from);
      });
      threads.push(thread);
      return thread;
    },
    ...options,
  });
  return { parse, threads };
}

/** A worker's window: opened by its step's `open`, refused when it has none and holds none. */
const windowed =
  (step: (number: number) => { batch?: TranscriptBatchShell; more: boolean }, events: TranscriptEvent[] = []) =>
  (message: Asked, thread: ScriptedThread): void => {
    if (message.op !== 'window-next') return;
    if (!thread.windows.has(message.window)) {
      if (message.open === undefined) {
        thread.refuse(message.id, { message: WINDOW_LOST });
        return;
      }
      thread.windows.add(message.window);
    }
    thread.answer(message.id, { kind: 'step', ...step(message.window) }, events);
  };

const inlineBatch: TranscriptBatch = {
  harness: 'claude',
  file: '/t.jsonl',
  reset: false,
  cursor: { byteOffset: 1, pendingBytes: 0 },
  events: [],
  observedInputs: [],
  issues: [],
};

/** The inline source: every call recorded, answering `inlineBatch`. */
function inlineSource() {
  const calls: unknown[][] = [];
  const windows: TranscriptWindow[] = [];
  const source: TranscriptSource = {
    harness: 'claude',
    read: async (...args) => {
      calls.push(['read', ...args]);
      return inlineBatch;
    },
    follow: (...args) => {
      calls.push(['follow', ...args]);
      return (async function* () {
        yield inlineBatch;
      })();
    },
    window: (file, options) => {
      calls.push(['window', file, options]);
      const window: TranscriptWindow = {
        file,
        next: async () => {
          calls.push(['next']);
          return { more: false };
        },
      };
      windows.push(window);
      return window;
    },
  };
  return { source, calls, windows };
}

const refusal = async (pending: Promise<unknown>): Promise<string> =>
  await pending.then(
    () => 'answered',
    (error: Error) => error.message,
  );

const START = { start: { at: 'beginning' } } as const;

describe('WorkerTranscriptSource.read', () => {
  it('should greet the thread with its hand-off scope, then answer a read as the inline reader does', async () => {
    // Arrange
    const events = [event('a'), event('b')];
    const records = [raw(0, 'first\n'), raw(6, 'second\n')];
    const scope = { roots: ['/home/x'], coordinatorHomes: ['/home/y'] };
    const { parse, threads } = worker(
      (message, thread) => {
        if (message.op === 'read')
          thread.answer(message.id, { kind: 'batch', batch: shell({ raw: true }) }, events, records);
      },
      { handoffScope: scope },
    );
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);

    // Act
    const batch = await source.read('/t.jsonl', { sessionId: 's1' });
    parse.close();

    // Assert
    should(threads[0]?.sent[0]).deepEqual({ op: 'configure', handoffScope: scope });
    should(threads[0]?.asked[0]).deepEqual({
      id: 1,
      op: 'read',
      harness: 'claude',
      file: '/t.jsonl',
      options: { sessionId: 's1' },
    });
    should(batch.events).deepEqual(events);
    should(batch.rawRecords?.map(each => [each.byteOffset, new TextDecoder().decode(each.bytes)])).deepEqual([
      [0, 'first\n'],
      [6, 'second\n'],
    ]);
    should(batch.cursor).deepEqual({ byteOffset: 12, pendingBytes: 0, nextLine: 3 });
    should(batch).not.have.property('raw');
  });

  it('should carry no raw records when the read had none, and ask with empty options when given none', async () => {
    // Arrange
    const { parse, threads } = worker((message, thread) => {
      if (message.op === 'read')
        thread.answer(message.id, { kind: 'batch', batch: shell({ reset: true }) }, [event('a')]);
    });
    const source = new WorkerTranscriptSource('codex', parse, inlineSource().source);

    // Act
    const batch = await source.read('/t.jsonl');
    parse.close();

    // Assert
    should(batch).not.have.property('rawRecords');
    should(batch.reset).be.true();
    should(batch.events).have.length(1);
    const asked = threads[0]?.asked[0];
    should(asked?.op === 'read' ? asked.options : 'not a read').deepEqual({});
  });

  it("should refuse with the worker's message, drop pages that arrive after, and keep the thread for the next read", async () => {
    // Arrange
    const { parse, threads } = worker((message, thread) => {
      if (message.op !== 'read') return;
      if (message.file === '/bad.jsonl') {
        thread.refuse(message.id, { message: 'could not read' });
        thread.say({ id: message.id, page: { events: [event('late')] } });
        return;
      }
      thread.answer(message.id, { kind: 'batch', batch: shell() });
    });
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);

    // Act
    const refused = await refusal(source.read('/bad.jsonl'));
    const next = await source.read('/ok.jsonl');
    parse.close();

    // Assert
    should(refused).equal('could not read');
    should(next.events).deepEqual([]);
    should(threads).have.length(1);
    should(parse.inFlight).equal(0);
  });

  it('should refuse an answer that is not the kind it asked for', async () => {
    // Arrange
    const { parse } = worker((message, thread) => {
      thread.answer(message.id, { kind: 'preview', preview: undefined });
    });
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);

    // Act
    const refused = await refusal(source.read('/t.jsonl'));
    parse.close();

    // Assert
    should(refused).equal('the transcript worker answered with preview, not batch');
  });

  it('should leave a live follow to the inline source', async () => {
    // Arrange
    const inline = inlineSource();
    const { parse, threads } = worker(() => undefined);
    const source = new WorkerTranscriptSource('claude', parse, inline.source);

    // Act
    const seen: TranscriptBatch[] = [];
    for await (const batch of source.follow('/t.jsonl', { startAt: 'end' })) seen.push(batch);

    // Assert
    should(seen).deepEqual([inlineBatch]);
    should(inline.calls).deepEqual([['follow', '/t.jsonl', { startAt: 'end' }]]);
    should(threads).have.length(0);
  });
});

describe('a worker that is retired or backing off', () => {
  it('should not be asked, and the inline reader answers, until its back-off has passed', async () => {
    // Arrange
    let now = 1_000;
    let crash = true;
    const inline = inlineSource();
    const { parse, threads } = worker(
      (message, thread) => {
        if (crash) thread.crash('boom');
        else thread.answer(message.id, { kind: 'batch', batch: shell() });
      },
      { now: () => now },
    );
    const source = new WorkerTranscriptSource('claude', parse, inline.source);

    // Act
    const failed = await refusal(source.read('/t.jsonl'));
    const whileBackingOff = parse.available;
    const inlined = await source.read('/t.jsonl', { sessionId: 'inline' });
    crash = false;
    now += 1_000;
    const recovered = await source.read('/t.jsonl');
    parse.close();

    // Assert
    should(failed).equal('the transcript worker failed: boom');
    should(whileBackingOff).be.false();
    should(inlined).equal(inlineBatch);
    should(inline.calls).deepEqual([['read', '/t.jsonl', { sessionId: 'inline' }]]);
    should(recovered.events).deepEqual([]);
    should(threads).have.length(2);
  });

  it('should be retired for good after too many failures, and say so once', async () => {
    // Arrange
    let now = 1_000;
    let told = 0;
    const { parse } = worker((_message, thread) => thread.crash('boom'), {
      now: () => now,
      retired: () => {
        told += 1;
      },
    });
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);

    // Act
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await refusal(source.read('/t.jsonl'));
      now += 31_000;
    }
    const available = parse.available;
    await source.read('/t.jsonl');

    // Assert
    should(available).be.false();
    should(told).equal(1);
  });

  it('should give up on a thread that does not answer in time, and refuse what it held', async () => {
    // Arrange
    const { parse, threads } = worker(() => undefined, { timeoutMs: 10 });
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);

    // Act
    const refused = await refusal(source.read('/t.jsonl'));

    // Assert
    should(refused).equal('the transcript worker did not read /t.jsonl within 10 ms');
    should(threads[0]?.terminated).be.true();
  });
});

describe('WorkerTranscriptSource.window', () => {
  it('should open the window with its first step only, and answer each step as the inline window does', async () => {
    // Arrange
    let step = 0;
    const { parse, threads } = worker(
      windowed(() => {
        step += 1;
        return step === 1
          ? { batch: shell({ cursor: { byteOffset: 5, pendingBytes: 1 } }), more: true }
          : step === 2
            ? { more: false }
            : { batch: shell({ raw: true }), more: false };
      }, [event('a')]),
    );
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    const window = source.window('/t.jsonl', { sessionId: 's1', ...START });

    // Act
    const first = await window.next();
    const second = await window.next();
    const third = await window.next();
    parse.close();

    // Assert
    should(window.file).equal('/t.jsonl');
    should(first.more).be.true();
    should(first.batch?.events).deepEqual([event('a')]);
    should(first.batch?.cursor).deepEqual({ byteOffset: 5, pendingBytes: 1 });
    should(first.batch).not.have.property('rawRecords');
    should(second).deepEqual({ more: false });
    should(third.batch?.rawRecords).deepEqual([]);
    should(threads[0]?.asked.map(each => ('open' in each ? each.open : 'no opening'))).deepEqual([
      { harness: 'claude', file: '/t.jsonl', options: { sessionId: 's1', ...START }, raw: false },
      'no opening',
      'no opening',
    ]);
  });

  it('should run the steps of one window one at a time, in the order they were asked', async () => {
    // Arrange
    const answers: ((value: TranscriptParseValue) => void)[] = [];
    const { parse, threads } = worker((message, thread) => {
      if (message.op === 'window-next') answers.push(value => thread.answer(message.id, value));
    });
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    const window = source.window('/t.jsonl', START);

    // Act
    const first = window.next();
    const second = window.next();
    await Bun.sleep(5);
    const sentBefore = threads[0]?.asked.length;
    answers[0]?.({ kind: 'step', more: true });
    const one = await first;
    await Bun.sleep(5);
    const sentAfter = threads[0]?.asked.length;
    answers[1]?.({ kind: 'step', more: false });
    const two = await second;
    parse.close();

    // Assert
    should([sentBefore, sentAfter]).deepEqual([1, 2]);
    should([one.more, two.more]).deepEqual([true, false]);
  });

  it('should keep stepping after a step was refused, in order, and refuse a lost window rather than re-open it', async () => {
    // Arrange
    const { parse, threads } = worker((message, thread) => {
      if (message.op === 'window-next') thread.refuse(message.id, { message: WINDOW_LOST });
    });
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    const window = source.window('/t.jsonl', START);

    // Act
    const results = await Promise.all([refusal(window.next()), refusal(window.next())]);
    parse.close();

    // Assert
    should(results).deepEqual([WINDOW_LOST, WINDOW_LOST]);
    should(threads[0]?.asked.map(each => 'open' in each)).deepEqual([true, false]);
  });

  it('should refuse a step after the thread that held the window ended, and never open it again in a new one', async () => {
    // Arrange
    const { parse, threads } = worker(windowed(() => ({ batch: shell(), more: false })));
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    const window = source.window('/t.jsonl', START);
    await window.next();

    // Act — the thread ends (idle, failure or close) and the next step finds a thread that holds nothing.
    parse.close();
    const lost = await refusal(window.next());
    const again = await refusal(window.next());
    parse.close();

    // Assert
    should(lost).equal(WINDOW_LOST);
    should(again).equal(WINDOW_LOST);
    should(threads).have.length(2);
    should(threads[1]?.asked.every(each => !('open' in each))).be.true();
    should(threads[1]?.windows.size).equal(0);
  });

  it('should refuse a step after a failed first step too, rather than open the window again', async () => {
    // Arrange
    let now = 1_000;
    let crash = true;
    const { parse, threads } = worker(
      (message, thread) => {
        if (crash) return thread.crash('boom');
        windowed(() => ({ batch: shell(), more: false }))(message, thread);
      },
      { now: () => now },
    );
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    const window = source.window('/t.jsonl', START);

    // Act
    const failed = await refusal(window.next());
    crash = false;
    now += 1_000;
    const later = await refusal(window.next());
    parse.close();

    // Assert
    should(failed).equal('the transcript worker failed: boom');
    should(later).equal(WINDOW_LOST);
    should(threads[1]?.asked.every(each => !('open' in each))).be.true();
  });

  it('should tell the worker a window is dropped once, and never start a thread to say so', async () => {
    // Arrange
    const released: ((held: number) => void)[] = [];
    const watched: { target: object; held: number }[] = [];
    const { parse, threads } = worker(
      windowed(() => ({ more: false })),
      {
        registry: release => {
          released.push(release);
          return { register: (target, held) => watched.push({ target, held }) };
        },
      },
    );
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    const window = source.window('/t.jsonl', START);
    await window.next();
    const number = watched[0]?.held as number;
    source.window('/never-stepped.jsonl', START);

    // Act
    released[0]?.(number);
    released[0]?.(number);
    parse.close();
    released[0]?.(watched[1]?.held as number);
    const threadsAfter = threads.length;

    // Assert
    should(watched).have.length(2);
    should(watched[0]?.target).equal(window);
    should(threads[0]?.sent.filter(each => 'op' in each && each.op === 'window-close')).deepEqual([
      { op: 'window-close', window: number },
    ]);
    should(threadsAfter).equal(1);
  });

  it('should forget a window whose step failed, and give each window its own number', async () => {
    // Arrange
    const watched: number[] = [];
    const { parse, threads } = worker(
      (message, thread) => {
        if (message.op === 'window-next') thread.refuse(message.id, { message: 'unreadable' });
      },
      { registry: () => ({ register: (_target, held) => void watched.push(held) }) },
    );
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    const one = source.window('/a.jsonl', START);
    const two = source.window('/b.jsonl', START);

    // Act
    const refused = await refusal(one.next());
    await two.next().catch(() => undefined);
    parse.close();

    // Assert
    should(refused).equal('unreadable');
    should(watched).deepEqual([1, 2]);
    should(threads[0]?.sent.filter(each => 'op' in each && each.op === 'window-close')).deepEqual([
      { op: 'window-close', window: 1 },
      { op: 'window-close', window: 2 },
    ]);
  });

  it('should be released by the real finalization registry when the proxy is collected', async () => {
    // Arrange
    const { parse, threads } = worker(windowed(() => ({ more: false })));
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);
    await (async () => {
      await source.window('/t.jsonl', START).next();
    })();

    // Act
    for (let attempt = 0; attempt < 50; attempt += 1) {
      Bun.gc(true);
      await Bun.sleep(5);
      if (threads[0]?.sent.some(each => 'op' in each && each.op === 'window-close')) break;
    }
    parse.close();

    // Assert
    should(threads[0]?.sent.filter(each => 'op' in each && each.op === 'window-close')).deepEqual([
      { op: 'window-close', window: 1 },
    ]);
  });

  it('should open a window inline when the worker is not available then, or turns unavailable before its first step', async () => {
    // Arrange
    const now = 1_000;
    const inline = inlineSource();
    const { parse, threads } = worker((_message, thread) => thread.crash('boom'), { now: () => now });
    const source = new WorkerTranscriptSource('claude', parse, inline.source);
    const early = source.window('/early.jsonl', START);
    await refusal(source.read('/t.jsonl'));

    // Act
    const direct = source.window('/direct.jsonl', START);
    const viaInline = await early.next();
    const viaDirect = await direct.next();
    const sent = threads[0]?.asked.map(each => each.op);

    // Assert — the window opened before the failure never reached the thread; both answer from the inline window.
    should(viaInline).deepEqual({ more: false });
    should(viaDirect).deepEqual({ more: false });
    should(inline.calls.map(each => each[0])).deepEqual(['window', 'window', 'next', 'next']);
    should(inline.windows.map(each => each.file)).deepEqual(['/direct.jsonl', '/early.jsonl']);
    should(sent).deepEqual(['read']);
    parse.close();
  });

  it('should keep a thread that holds a window for the long hold and an idle one for the short', async () => {
    // Arrange
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return (original as (...args: unknown[]) => unknown)(handler, ms, ...rest);
    }) as unknown as typeof setTimeout;
    const { parse } = worker((message, thread) => {
      if (message.op === 'read') thread.answer(message.id, { kind: 'batch', batch: shell() });
      else windowed(() => ({ more: false }))(message, thread);
    });
    const source = new WorkerTranscriptSource('claude', parse, inlineSource().source);

    // Act — answering a request arms the idle timer, reading the idle time at that moment.
    try {
      await source.read('/t.jsonl');
      const window = source.window('/t.jsonl', START);
      await window.next();
      parse.close();
    } finally {
      globalThis.setTimeout = original;
    }

    // Assert
    should(delays.filter(each => each !== 120_000)).deepEqual([30_000, 6 * 60 * 60_000]);
  });
});

describe('WorkerTranscriptImages', () => {
  const HANDLE = '4096.100.0';
  const target = { file: '/t.jsonl', harness: 'claude' } as const;
  const image = { handle: HANDLE, mediaType: 'image/png', byteLength: 3 } as const;

  function images(
    script: (message: Asked, thread: ScriptedThread) => void,
    options: Partial<TranscriptParseWorkerOptions> = {},
    located: typeof target | null = target,
  ) {
    const inlineCalls: unknown[][] = [];
    const lookup = (extra: string): TranscriptImageLookup => ({
      etag: `"inline-${extra}"`,
      image,
      download: async () => ({ image, base64: `inline-${extra}` }),
    });
    const { parse, threads } = worker(script, options);
    const located$: string[] = [];
    const proxy = new WorkerTranscriptImages(
      parse,
      {
        locate: async sessionId => {
          located$.push(sessionId);
          return located ?? undefined;
        },
      },
      {
        lookup: async (...args) => {
          inlineCalls.push(['lookup', ...args]);
          return lookup('lookup');
        },
        lookupAt: async (...args) => {
          inlineCalls.push(['lookupAt', ...args]);
          return lookup('at');
        },
      },
    );
    return { parse, threads, proxy, inlineCalls, located: located$ };
  }

  const proven = (message: Asked, thread: ScriptedThread): void => {
    if (message.op !== 'image') return;
    thread.answer(message.id, {
      kind: 'image',
      etag: '"worker"',
      image,
      ...(message.download ? { base64: 'AAAA' } : {}),
    });
  };

  it('should locate here and prove on the worker, and ask again for the bytes only when they are wanted', async () => {
    // Arrange
    const { parse, threads, proxy, located } = images(proven);

    // Act
    const found = await proxy.lookup('s1', HANDLE);
    const askedBeforeDownload = threads[0]?.asked.length;
    const downloaded = await found.download();
    parse.close();

    // Assert
    should(found.etag).equal('"worker"');
    should(found.image).deepEqual(image);
    should(located).deepEqual(['s1']);
    should(askedBeforeDownload).equal(1);
    should(downloaded).deepEqual({ image, base64: 'AAAA' });
    should(threads[0]?.asked.map(each => ('download' in each ? each.download : undefined))).deepEqual([false, true]);
    should(threads[0]?.asked[0]).deepEqual({
      id: 1,
      op: 'image',
      sessionId: 's1',
      handle: HANDLE,
      target,
      download: false,
    });
  });

  it('should leave a handle that is not one, and a session with no transcript, to the inline reader to refuse', async () => {
    // Arrange
    const missing = images(proven, {}, null);
    const present = images(proven);

    // Act
    const notAHandle = await present.proxy.lookup('s1', 'nonsense');
    const noTranscript = await missing.proxy.lookup('s1', HANDLE);
    present.parse.close();
    missing.parse.close();

    // Assert
    should(notAHandle.etag).equal('"inline-lookup"');
    should(noTranscript.etag).equal('"inline-lookup"');
    should(present.located).deepEqual([]);
    should(present.inlineCalls).deepEqual([['lookup', 's1', 'nonsense']]);
    should(missing.inlineCalls).deepEqual([['lookup', 's1', HANDLE]]);
    should(present.threads).have.length(0);
  });

  it('should raise a refusal as the image error it was, so the route restates it', async () => {
    // Arrange
    const { parse, proxy } = images((message, thread) => {
      thread.refuse(message.id, { message: 'no such image', imageFailure: 'image_not_found' });
    });

    // Act
    const error = await proxy.lookup('s1', HANDLE).catch((caught: unknown) => caught);
    parse.close();

    // Assert
    should(error).be.instanceOf(TranscriptImageError);
    should((error as TranscriptImageError).failure).equal('image_not_found');
    should((error as Error).message).equal('no such image');
  });

  it('should answer from the inline reader when the worker is not available, for the lookup and for the bytes', async () => {
    // Arrange
    const now = 1_000;
    const { parse, proxy, inlineCalls, threads } = images(
      (message, thread) => {
        if (message.op === 'image' && message.download) thread.crash('boom');
        else proven(message, thread);
      },
      { now: () => now },
    );
    const found = await proxy.lookup('s1', HANDLE);

    // Act
    const downloaded = await found.download().catch((error: Error) => error.message);
    const whileBackingOff = await found.download();
    const lookedUp = await proxy.lookup('s1', HANDLE);
    parse.close();

    // Assert
    should(downloaded).equal('the transcript worker failed: boom');
    should(whileBackingOff).deepEqual({ image, base64: 'inline-at' });
    should(lookedUp.etag).equal('"inline-lookup"');
    should(inlineCalls).deepEqual([
      ['lookupAt', 's1', HANDLE, target],
      ['lookup', 's1', HANDLE],
    ]);
    should(threads).have.length(1);
  });

  it('should refuse a download the worker answered without its bytes', async () => {
    // Arrange
    const { parse, proxy } = images((message, thread) => {
      thread.answer(message.id, { kind: 'image', etag: '"worker"', image });
    });
    const found = await proxy.lookup('s1', HANDLE);

    // Act
    const refused = await refusal(found.download());
    parse.close();

    // Assert
    should(refused).equal('the transcript worker answered a download without its bytes');
  });
});

describe('WorkerForeignTranscriptReader', () => {
  const candidate = { harness: 'claude', source: '/h/a.jsonl' } as const;
  const conversation = {
    id: 'c1',
    harness: 'claude',
    title: 'T',
    source: '/h/a.jsonl',
    eventCount: 2,
    readOnly: true,
  } as const;

  function reader(
    script: (message: Asked, thread: ScriptedThread) => void,
    options: Partial<TranscriptParseWorkerOptions> = {},
  ) {
    const calls: unknown[][] = [];
    const inline: ForeignTranscriptReader = {
      read: async (...args) => {
        calls.push(args);
        return { reason: 'inline' };
      },
    };
    const { parse, threads } = worker(script, options);
    return { parse, threads, calls, proxy: new WorkerForeignTranscriptReader(parse, inline) };
  }

  it('should read the row, and the events from their pages, from the worker', async () => {
    // Arrange
    const { parse, threads, proxy } = reader((message, thread) => {
      thread.answer(message.id, { kind: 'foreign', conversation }, [event('a'), event('b')]);
    });

    // Act
    const read = await proxy.read(candidate, true);
    parse.close();

    // Assert
    should(read).deepEqual({ conversation, events: [event('a'), event('b')] });
    should(threads[0]?.asked[0]).deepEqual({ id: 1, op: 'foreign', candidate, withEvents: true });
  });

  it('should say why the worker skipped a transcript', async () => {
    // Arrange
    const { parse, proxy } = reader((message, thread) => {
      thread.answer(message.id, { kind: 'foreign-skipped', reason: 'too large' });
    });

    // Act
    const read = await proxy.read(candidate, false);
    parse.close();

    // Assert
    should(read).deepEqual({ reason: 'too large' });
  });

  it('should refuse a worker that answered with another kind, and use the inline reader when it is not available', async () => {
    // Arrange
    const now = 1_000;
    let wrong = true;
    const { parse, proxy, calls } = reader(
      (message, thread) => {
        if (wrong) thread.answer(message.id, { kind: 'preview', preview: undefined });
        else thread.crash('boom');
      },
      { now: () => now },
    );

    // Act
    const refused = await refusal(proxy.read(candidate, true));
    wrong = false;
    await refusal(proxy.read(candidate, true));
    const inlined = await proxy.read(candidate, false);
    parse.close();

    // Assert
    should(refused).equal('the transcript worker answered with preview, not foreign');
    should(inlined).deepEqual({ reason: 'inline' });
    should(calls).deepEqual([[candidate, false]]);
  });
});

describe('WorkerConversationDescriber', () => {
  const candidate = {
    harness: 'claude',
    source: '/h/a.jsonl',
    relativePath: 'projects/x/a.jsonl',
    nameId: 'a',
  } as const;
  const described = { id: 'a', harness: 'claude', title: 'T' } as never;
  const preview = { recent: [] } as never;

  function describer(
    script: (message: Asked, thread: ScriptedThread) => void,
    options: Partial<TranscriptParseWorkerOptions> = {},
  ) {
    const calls: unknown[][] = [];
    const inline: ConversationDescriber = {
      describe: async (...args) => {
        calls.push(['describe', ...args]);
        return undefined;
      },
      preview: async (...args) => {
        calls.push(['preview', ...args]);
        return undefined;
      },
    };
    const { parse, threads } = worker(script, options);
    return { parse, threads, calls, proxy: new WorkerConversationDescriber(parse, inline) };
  }

  it('should describe and preview on the worker', async () => {
    // Arrange
    const { parse, threads, proxy } = describer((message, thread) => {
      if (message.op === 'describe') thread.answer(message.id, { kind: 'described', described });
      else thread.answer(message.id, { kind: 'preview', preview });
    });

    // Act
    const row = await proxy.describe(candidate);
    const shown = await proxy.preview(candidate);
    parse.close();

    // Assert
    should(row).equal(described);
    should(shown).equal(preview);
    should(threads[0]?.asked.map(each => each.op)).deepEqual(['describe', 'preview']);
    should(threads[0]?.asked[1]).deepEqual({ id: 2, op: 'preview', candidate });
  });

  it('should answer from the inline describer when the worker is not available', async () => {
    // Arrange
    const { parse, proxy, calls } = describer((_message, thread) => thread.crash('boom'));
    await refusal(proxy.describe(candidate));

    // Act
    const row = await proxy.describe(candidate);
    const shown = await proxy.preview(candidate);
    parse.close();

    // Assert
    should(row).be.undefined();
    should(shown).be.undefined();
    should(calls).deepEqual([
      ['describe', candidate],
      ['preview', candidate],
    ]);
  });
});

describe('WorkerConversationIndex', () => {
  const target = { sessionId: 's1', harness: 'claude' } as const;
  const row = (n: number): PortableConversationRow =>
    ({ text: `row ${String(n)}`, rawPrefix: Uint8Array.of(n) }) as unknown as PortableConversationRow;
  const inlineRows = [row(99)];

  function indexed(
    script: (message: Asked, thread: ScriptedThread) => void,
    options: Partial<TranscriptParseWorkerOptions> = {},
  ) {
    const calls: unknown[][] = [];
    const inline: TranscriptRowsIndex = {
      rows: async (...args) => {
        calls.push(args);
        return inlineRows;
      },
    };
    const { parse, threads } = worker(script, options);
    return { parse, threads, calls, proxy: new WorkerConversationIndex(parse, inline) };
  }

  it('should fold on the worker and put the rows back together from their pages, in order', async () => {
    // Arrange
    const rows = Array.from({ length: 300 }, (_, n) => row(n));
    const { parse, threads, proxy } = indexed((message, thread) => {
      if (message.op !== 'rows') return;
      for (const { page } of rowPagesOf(rows)) thread.say({ id: message.id, page });
      thread.say({ id: message.id, ok: true, value: { kind: 'rows' } });
    });

    // Act — a caller's target may carry more than the index reads; only the two facts are sent.
    const folded = await proxy.rows({ ...target, extra: () => undefined } as never, '/t.jsonl');
    parse.close();

    // Assert
    should(folded).deepEqual(rows);
    should(threads[0]?.asked).deepEqual([{ id: 1, op: 'rows', target, file: '/t.jsonl' }]);
  });

  it('should answer nothing when no source in the worker speaks the harness', async () => {
    // Arrange
    const { parse, proxy } = indexed((message, thread) =>
      thread.say({ id: message.id, ok: true, value: { kind: 'rows', unspoken: true } }),
    );

    // Act
    const folded = await proxy.rows(target, '/t.jsonl');
    parse.close();

    // Assert
    should(folded).be.undefined();
  });

  it('should raise a digest refusal as the ConversationDigestError it was, so the operator is told why', async () => {
    // Arrange
    const { parse, proxy } = indexed((message, thread) =>
      thread.refuse(message.id, { message: 'transcript for s1 is damaged', digestFailure: 'incomplete_transcript' }),
    );

    // Act
    const error = await proxy.rows(target, '/t.jsonl').catch((caught: unknown) => caught);
    parse.close();

    // Assert
    should(error).be.instanceOf(ConversationDigestError);
    should((error as ConversationDigestError).failure).equal('incomplete_transcript');
    should((error as Error).message).equal('transcript for s1 is damaged');
  });

  it('should refuse an answer of another kind, and fold inline when the worker is not available', async () => {
    // Arrange
    let crash = false;
    const { parse, proxy, calls } = indexed((message, thread) => {
      if (crash) thread.crash('boom');
      else thread.answer(message.id, { kind: 'batch', batch: shell() });
    });

    // Act
    const wrong = await refusal(proxy.rows(target, '/t.jsonl'));
    crash = true;
    const crashed = await refusal(proxy.rows(target, '/t.jsonl'));
    const inlined = await proxy.rows(target, '/t.jsonl');
    parse.close();

    // Assert
    should(wrong).equal('the transcript worker answered with batch, not rows');
    should(crashed).equal('the transcript worker failed: boom');
    should(inlined).equal(inlineRows);
    should(calls).deepEqual([[target, '/t.jsonl']]);
  });
});
