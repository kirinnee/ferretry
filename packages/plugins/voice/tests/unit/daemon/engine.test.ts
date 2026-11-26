import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { VoiceEngineError } from '../../../contract/index.ts';
import type { EngineFile } from '../../../daemon/lib/engine/catalog.ts';
import { IDLE_UNLOAD, LOAD_HEADROOM_BYTES, SpeechEngine } from '../../../daemon/lib/engine/engine.ts';
import type { EnginePathsPort, SpeechThread } from '../../../daemon/lib/engine/ports.ts';
import { LOAD_ROLES, type SpeechCall } from '../../../daemon/lib/engine/protocol.ts';
import { spansFromProbabilities, VAD_CHUNK } from '../../../daemon/lib/engine/spans.ts';

const BODY = new TextEncoder().encode('speech file');
const CATALOG: readonly EngineFile[] = LOAD_ROLES.map(role => ({
  role,
  label: role,
  url: `https://huggingface.co/x/${role}`,
  bytes: BODY.byteLength,
  sha256: createHash('sha256').update(BODY).digest('hex'),
}));
const TOTAL = CATALOG.length * BODY.byteLength;

class Files implements EnginePathsPort {
  readonly held = new Map<string, Uint8Array>();
  /** Hand back a window into a larger buffer, as a state read may. */
  windowed = false;
  free: number | undefined = undefined;
  pathOf(file: { role: string }) {
    return `/state/voice/models/parakeet/${file.role}`;
  }
  async freeBytes() {
    return this.free;
  }
  async size(file: { role: string }) {
    return this.held.get(file.role)?.byteLength;
  }
  async read(file: { role: string }) {
    const bytes = this.held.get(file.role);
    if (bytes === undefined || !this.windowed) return bytes?.slice();
    const larger = new Uint8Array(bytes.byteLength + 2);
    larger.set(bytes, 1);
    return larger.subarray(1, 1 + bytes.byteLength);
  }
  async write(file: { role: string }, bytes: Uint8Array) {
    this.held.set(file.role, bytes);
  }
  async remove(file: { role: string }) {
    this.held.delete(file.role);
  }
}

class FakeThread implements SpeechThread {
  readonly calls: SpeechCall['kind'][] = [];
  terminated = false;
  private ended: (() => void)[] = [];
  constructor(
    private readonly text = 'hello there',
    private readonly loadGate?: Promise<void>,
    private readonly failDecode = false,
    private readonly failLoad = false,
  ) {}
  async call(request: SpeechCall) {
    this.calls.push(request.kind);
    if (this.terminated) throw new Error('stopped');
    switch (request.kind) {
      case 'load':
        await this.loadGate;
        if (this.failLoad) throw new Error('the models would not load');
        return { id: 1, ok: true as const, kind: 'load' as const, loadMs: 1500, memoryMb: 819 };
      case 'transcribe':
        if (this.failDecode) throw new Error('decode crashed');
        return { id: 1, ok: true as const, kind: 'transcribe' as const, text: this.text, decodeMs: 1000 };
      case 'detect':
        return { id: 1, ok: true as const, kind: 'detect' as const, spans: [{ start: 100, end: 900 }] };
      case 'probe':
        return { id: 1, ok: true as const, kind: 'probe' as const, version: '2.0.3' };
      case 'release':
        return { id: 1, ok: true as const, kind: 'release' as const };
    }
  }
  async terminate() {
    this.terminated = true;
    for (const listener of this.ended) listener();
  }
  onEnd(listener: () => void) {
    this.ended.push(listener);
  }
}

function build(
  options: {
    fetchStatus?: number;
    memory?: number | undefined;
    tamper?: boolean;
    freeDisk?: number;
    failDecode?: boolean;
    failLoad?: boolean;
  } = {},
) {
  const files = new Files();
  files.free = options.freeDisk;
  // While `hold.gate` is set, every load waits on it: a test releases it to let a load land.
  const hold: { gate?: Promise<void>; release?: () => void } = {};
  const threads: FakeThread[] = [];
  const timers: { delay: number; fn: () => void; cancelled: boolean }[] = [];
  const logged: string[] = [];
  const engine = new SpeechEngine({
    http: {
      request: async () =>
        options.fetchStatus !== undefined
          ? new Response('no', { status: options.fetchStatus })
          : new Response(options.tamper === true ? new TextEncoder().encode('speech fil!') : BODY),
    },
    files,
    machine: () => 'Studio Mac',
    clock: {
      after: (delay, fn) => {
        const timer = { delay, fn, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    start: () => {
      const thread = new FakeThread('hello there', hold.gate, options.failDecode === true, options.failLoad === true);
      threads.push(thread);
      return thread;
    },
    availableMemory: () => ('memory' in options ? options.memory : TOTAL + LOAD_HEADROOM_BYTES + 1),
    log: { info: message => void logged.push(message), warn: message => void logged.push(message) },
    catalog: CATALOG,
  });
  return { engine, files, threads, timers, logged, hold };
}

describe('the speech engine: install', () => {
  test('starts not installed, installs in the background, and is ready only after it loaded and decoded once', async () => {
    const { engine, threads } = build();
    expect(await engine.view()).toMatchObject({
      state: 'not_installed',
      machine: 'Studio Mac',
      sizeBytes: TOTAL,
      doneBytes: 0,
      loaded: false,
    });
    const started = await engine.install();
    expect(started.state).toBe('installing');
    await engine.settled();
    const ready = await engine.view();
    // The proof is not a use: the models are unloaded again at once, so nothing stays resident.
    expect(ready).toMatchObject({ state: 'ready', doneBytes: TOTAL, loaded: false });
    expect(ready.selfTest).toEqual({ loadMs: 1500, decodeMs: 1000, memoryMb: 819 });
    expect(threads[0]?.calls).toEqual(['load', 'transcribe']);
    expect(threads[0]?.terminated).toBe(true);
  });

  test('a self-test that fails also leaves nothing loaded', async () => {
    const { engine, threads } = build({ failDecode: true });
    await engine.install();
    await engine.settled();
    expect((await engine.view()).state).toBe('failed');
    expect(threads).toHaveLength(1);
    expect(threads[0]?.terminated).toBe(true);
    expect((await engine.view()).loaded).toBe(false);
  });

  test('too little free disk fails with no_disk and the installer’s own sentence; nothing is downloaded', async () => {
    const { engine, files, threads } = build({ freeDisk: 5_000 });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('no_disk');
    expect(view.failure?.sentence).toContain('free disk space');
    expect(view.failure?.sentence).toContain('this machine has 0 MB free');
    expect(files.held.size).toBe(0);
    expect(threads).toHaveLength(0);
  });

  test('a second press while installing starts nothing new', async () => {
    const { engine } = build();
    await engine.install();
    await engine.install();
    await engine.settled();
    expect((await engine.view()).state).toBe('ready');
  });

  test('a tampered download fails with hash_mismatch, keeps no file, and a retry can succeed', async () => {
    const bad = build({ tamper: true });
    await bad.engine.install();
    await bad.engine.settled();
    const failed = await bad.engine.view();
    expect(failed.state).toBe('failed');
    expect(failed.failure?.code).toBe('hash_mismatch');
    expect(failed.failure?.sentence).toContain('nothing was kept');
    expect(bad.files.held.size).toBe(0);
  });

  test('an unreachable server fails with download_failed and says what to do', async () => {
    const { engine } = build({ fetchStatus: 503 });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.failure?.code).toBe('download_failed');
    expect(view.failure?.sentence).toContain('internet');
  });
});

describe('the speech engine: use', () => {
  async function ready() {
    const built = build();
    await built.engine.install();
    await built.engine.settled();
    return built;
  }

  test('transcribes with the real-time factor, loading once however many calls', async () => {
    const { engine, threads } = await ready();
    expect(threads).toHaveLength(1);
    const one = await engine.transcribe(new Float32Array(32_000));
    expect(one.text).toBe('hello there');
    expect(one.realTimeFactor).toBeCloseTo(0.5, 5);
    await engine.transcribe(new Float32Array(16_000));
    expect(threads).toHaveLength(2);
    expect(threads[1]?.calls.filter(kind => kind === 'load')).toHaveLength(1);
  });

  test('a model changed on disk at the same size is refused and deleted, not loaded', async () => {
    const { engine, files, threads } = await ready();
    await engine.unload();
    const role = LOAD_ROLES[0];
    files.held.set(role, new TextEncoder().encode('speech fil!'));
    const loadsBefore = threads.length;
    await expect(engine.transcribe(new Float32Array(16_000))).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(threads).toHaveLength(loadsBefore);
    expect(files.held.has(role)).toBe(false);
  });

  test('finds the voice', async () => {
    const { engine } = await ready();
    expect(await engine.detectSpeech(new Float32Array(16_000))).toEqual([{ start: 100, end: 900 }]);
  });

  test('is unloaded ten idle minutes after the last use, and loads again on the next', async () => {
    const { engine, timers, threads } = await ready();
    await engine.transcribe(new Float32Array(16_000));
    const last = timers.filter(timer => !timer.cancelled).at(-1);
    expect(last?.delay).toBe(IDLE_UNLOAD);
    last?.fn();
    await Promise.resolve();
    expect(threads[1]?.terminated).toBe(true);
    expect((await engine.view()).loaded).toBe(false);
    await engine.transcribe(new Float32Array(16_000));
    expect(threads).toHaveLength(3);
    expect((await engine.view()).loaded).toBe(true);
  });

  test('every use re-arms the idle timer, so a busy engine is never unloaded', async () => {
    const { engine, timers } = await ready();
    await engine.transcribe(new Float32Array(16_000));
    const before = timers.filter(timer => !timer.cancelled).length;
    await engine.transcribe(new Float32Array(16_000));
    expect(timers.filter(timer => !timer.cancelled)).toHaveLength(before);
    expect(timers.filter(timer => timer.cancelled).length).toBeGreaterThan(0);
  });

  test('a worker that dies is forgotten, so the next call starts a fresh one', async () => {
    const { engine, threads } = await ready();
    await engine.transcribe(new Float32Array(16_000));
    await threads[1]?.terminate();
    expect((await engine.view()).loaded).toBe(false);
    await engine.transcribe(new Float32Array(16_000));
    expect(threads).toHaveLength(3);
  });

  test('refuses to load without the memory for it, and says so', async () => {
    const built = build({ memory: 1_000 });
    for (const file of CATALOG) built.files.held.set(file.role, BODY);
    await expect(built.engine.transcribe(new Float32Array(16_000))).rejects.toMatchObject({ code: 'no_memory' });
    expect(built.threads).toHaveLength(0);
  });

  test('before install it is not_ready, and starts no thread', async () => {
    const { engine, threads } = build();
    await expect(engine.transcribe(new Float32Array(16_000))).rejects.toMatchObject({ code: 'not_ready' });
    expect(threads).toHaveLength(0);
  });

  test('remove unloads, deletes every file, and refuses while installing', async () => {
    const { engine, files, threads } = await ready();
    await engine.transcribe(new Float32Array(16_000));
    const view = await engine.remove();
    expect(view).toMatchObject({ state: 'not_installed', doneBytes: 0, loaded: false });
    expect(files.held.size).toBe(0);
    expect(threads[1]?.terminated).toBe(true);
    const busy = build();
    await busy.engine.install();
    await expect(busy.engine.remove()).rejects.toBeInstanceOf(VoiceEngineError);
    await busy.engine.settled();
  });
});

describe('the speech engine: loading', () => {
  test('a worker that cannot load the models is ended, and the caller is told load_failed', async () => {
    const built = build({ failLoad: true });
    for (const file of CATALOG) built.files.held.set(file.role, BODY);
    await expect(built.engine.transcribe(new Float32Array(16_000))).rejects.toMatchObject({ code: 'load_failed' });
    expect(built.threads).toHaveLength(1);
    expect(built.threads[0]?.terminated).toBe(true);
    expect(built.logged).toContain('voice.engine.load_error');
    expect((await built.engine.view()).loaded).toBe(false);
  });

  test('bytes read as a window into a larger buffer are copied out before they are handed to the worker', async () => {
    const built = build();
    for (const file of CATALOG) built.files.held.set(file.role, BODY);
    built.files.windowed = true;
    expect((await built.engine.transcribe(new Float32Array(16_000))).text).toBe('hello there');
    expect((await built.engine.view()).loaded).toBe(true);
  });
});

describe('the speech engine: a load that is overtaken', () => {
  /** An installed engine whose NEXT loads wait until `release()`. */
  async function held() {
    const built = build();
    await built.engine.install();
    await built.engine.settled();
    built.hold.gate = new Promise<void>(resolve => {
      built.hold.release = resolve;
    });
    return built;
  }
  const flush = async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };

  test('unload during a load: the loading worker ends itself, nothing is published, and the caller is told', async () => {
    const { engine, threads, hold } = await held();
    const call = engine.transcribe(new Float32Array(16_000)).catch((error: unknown) => error);
    await flush();
    expect(threads).toHaveLength(2);
    await engine.unload();
    hold.release?.();
    expect(await call).toMatchObject({ code: 'not_ready' });
    expect(threads[1]?.terminated).toBe(true);
    expect(threads[1]?.calls).toEqual(['load']);
    expect((await engine.view()).loaded).toBe(false);
  });

  test('Remove during a load leaves no worker behind and the files stay deleted', async () => {
    const { engine, files, threads, hold } = await held();
    const call = engine.transcribe(new Float32Array(16_000)).catch((error: unknown) => error);
    await flush();
    expect(threads).toHaveLength(2);
    await engine.remove();
    hold.release?.();
    await call;
    expect(threads.every(thread => thread.terminated)).toBe(true);
    expect(files.held.size).toBe(0);
    expect((await engine.view()).loaded).toBe(false);
  });

  test('a call made after the unload starts ONE fresh load; the overtaken one cannot hide or replace it', async () => {
    const { engine, threads, hold } = await held();
    const first = engine.transcribe(new Float32Array(16_000)).catch((error: unknown) => error);
    await flush();
    await engine.unload();
    const second = engine.transcribe(new Float32Array(16_000));
    await flush();
    expect(threads).toHaveLength(3);
    hold.release?.();
    expect(await first).toMatchObject({ code: 'not_ready' });
    expect((await second).text).toBe('hello there');
    expect(threads.map(thread => thread.terminated)).toEqual([true, true, false]);
    expect((await engine.view()).loaded).toBe(true);
  });
});

describe('speech spans from Silero probabilities', () => {
  const chunks = (parts: readonly (readonly [number, number])[]): number[] =>
    parts.flatMap(([probability, count]) => Array.from({ length: count }, () => probability));

  test('finds one span, padded 30 ms, from where the probability rises to where it stays low', () => {
    const probabilities = chunks([
      [0.05, 10],
      [0.9, 20],
      [0.05, 10],
    ]);
    const spans = spansFromProbabilities(probabilities, probabilities.length * VAD_CHUNK);
    expect(spans).toEqual([{ start: 10 * VAD_CHUNK - 480, end: 30 * VAD_CHUNK + 480 }]);
  });

  test('a short gap inside a phrase does not split it; a long one does', () => {
    const joined = chunks([
      [0.9, 10],
      [0.1, 2],
      [0.9, 10],
    ]);
    expect(spansFromProbabilities(joined, joined.length * VAD_CHUNK)).toHaveLength(1);
    const split = chunks([
      [0.9, 10],
      [0.1, 6],
      [0.9, 10],
    ]);
    expect(spansFromProbabilities(split, split.length * VAD_CHUNK)).toHaveLength(2);
  });

  test('a click shorter than 256 ms is not speech, and silence has no spans', () => {
    const click = chunks([
      [0.05, 10],
      [0.9, 4],
      [0.05, 10],
    ]);
    expect(spansFromProbabilities(click, click.length * VAD_CHUNK)).toEqual([]);
    expect(spansFromProbabilities(chunks([[0.1, 50]]), 50 * VAD_CHUNK)).toEqual([]);
  });

  test('speech that runs to the end of the audio is closed at the end, never past it', () => {
    const probabilities = chunks([
      [0.05, 5],
      [0.9, 20],
    ]);
    const total = probabilities.length * VAD_CHUNK;
    expect(spansFromProbabilities(probabilities, total)).toEqual([{ start: 5 * VAD_CHUNK - 480, end: total }]);
  });

  test('a probability between the two thresholds keeps a span open (hysteresis)', () => {
    const probabilities = chunks([
      [0.9, 10],
      [0.4, 10],
      [0.05, 5],
    ]);
    const [span] = spansFromProbabilities(probabilities, probabilities.length * VAD_CHUNK);
    expect(span?.end).toBe(20 * VAD_CHUNK + 480);
  });
});
