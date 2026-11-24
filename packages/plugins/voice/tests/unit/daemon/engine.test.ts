import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { VoiceEngineError } from '../../../contract/index.ts';
import type { EngineFile } from '../../../daemon/lib/engine/catalog.ts';
import { IDLE_UNLOAD, LOAD_HEADROOM_BYTES, SpeechEngine } from '../../../daemon/lib/engine/engine.ts';
import type { EngineFilesPort, SpeechThread } from '../../../daemon/lib/engine/ports.ts';
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

class Files implements EngineFilesPort {
  readonly held = new Map<string, Uint8Array>();
  async size(file: { role: string }) {
    return this.held.get(file.role)?.byteLength;
  }
  async read(file: { role: string }) {
    return this.held.get(file.role)?.slice();
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
  constructor(private readonly text = 'hello there') {}
  async call(request: SpeechCall) {
    this.calls.push(request.kind);
    if (this.terminated) throw new Error('stopped');
    switch (request.kind) {
      case 'load':
        return { id: 1, ok: true as const, kind: 'load' as const, loadMs: 1500, memoryMb: 819 };
      case 'transcribe':
        return { id: 1, ok: true as const, kind: 'transcribe' as const, text: this.text, decodeMs: 1000 };
      case 'detect':
        return { id: 1, ok: true as const, kind: 'detect' as const, spans: [{ start: 100, end: 900 }] };
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

function build(options: { fetchStatus?: number; memory?: number | undefined; tamper?: boolean } = {}) {
  const files = new Files();
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
      const thread = new FakeThread();
      threads.push(thread);
      return thread;
    },
    availableMemory: () => ('memory' in options ? options.memory : TOTAL + LOAD_HEADROOM_BYTES + 1),
    log: { info: message => void logged.push(message), warn: message => void logged.push(message) },
    catalog: CATALOG,
  });
  return { engine, files, threads, timers, logged };
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
    expect(ready).toMatchObject({ state: 'ready', doneBytes: TOTAL, loaded: true });
    expect(ready.selfTest).toEqual({ loadMs: 1500, decodeMs: 1000, memoryMb: 819 });
    expect(threads[0]?.calls).toEqual(['load', 'transcribe']);
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
    const one = await engine.transcribe(new Float32Array(32_000));
    expect(one.text).toBe('hello there');
    expect(one.realTimeFactor).toBeCloseTo(0.5, 5);
    await engine.transcribe(new Float32Array(16_000));
    expect(threads).toHaveLength(1);
    expect(threads[0]?.calls.filter(kind => kind === 'load')).toHaveLength(1);
  });

  test('finds the voice', async () => {
    const { engine } = await ready();
    expect(await engine.detectSpeech(new Float32Array(16_000))).toEqual([{ start: 100, end: 900 }]);
  });

  test('is unloaded ten idle minutes after the last use, and loads again on the next', async () => {
    const { engine, timers, threads } = await ready();
    const last = timers.filter(timer => !timer.cancelled).at(-1);
    expect(last?.delay).toBe(IDLE_UNLOAD);
    last?.fn();
    await Promise.resolve();
    expect(threads[0]?.terminated).toBe(true);
    expect((await engine.view()).loaded).toBe(false);
    await engine.transcribe(new Float32Array(16_000));
    expect(threads).toHaveLength(2);
    expect((await engine.view()).loaded).toBe(true);
  });

  test('every use re-arms the idle timer, so a busy engine is never unloaded', async () => {
    const { engine, timers } = await ready();
    const before = timers.filter(timer => !timer.cancelled).length;
    await engine.transcribe(new Float32Array(16_000));
    expect(timers.filter(timer => !timer.cancelled)).toHaveLength(before);
    expect(timers.filter(timer => timer.cancelled).length).toBeGreaterThan(0);
  });

  test('a worker that dies is forgotten, so the next call starts a fresh one', async () => {
    const { engine, threads } = await ready();
    await threads[0]?.terminate();
    expect((await engine.view()).loaded).toBe(false);
    await engine.transcribe(new Float32Array(16_000));
    expect(threads).toHaveLength(2);
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
    const view = await engine.remove();
    expect(view).toMatchObject({ state: 'not_installed', doneBytes: 0, loaded: false });
    expect(files.held.size).toBe(0);
    expect(threads[0]?.terminated).toBe(true);
    const busy = build();
    await busy.engine.install();
    await expect(busy.engine.remove()).rejects.toBeInstanceOf(VoiceEngineError);
    await busy.engine.settled();
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
