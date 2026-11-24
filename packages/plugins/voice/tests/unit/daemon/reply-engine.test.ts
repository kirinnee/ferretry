import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { REPLY_SPEAKER_ID, ReplyVoiceViewSchema, VoiceEngineError } from '../../../contract/index.ts';
import { REPLY_FILES, REPLY_ROLES, type ReplyFile } from '../../../daemon/lib/reply/catalog.ts';
import { REPLY_IDLE_UNLOAD, REPLY_LOAD_HEADROOM_BYTES, ReplyVoiceEngine } from '../../../daemon/lib/reply/engine.ts';
import type { EnginePathsPort, ReplyThread } from '../../../daemon/lib/engine/ports.ts';
import type { ReplyCall } from '../../../daemon/lib/reply/protocol.ts';

const BODY = new TextEncoder().encode('voice file');
const CATALOG: readonly ReplyFile[] = REPLY_ROLES.map(role => ({
  role,
  label: role,
  url: `https://huggingface.co/x/${role}`,
  bytes: BODY.byteLength,
  sha256: createHash('sha256').update(BODY).digest('hex'),
}));
const TOTAL = CATALOG.length * BODY.byteLength;

class Files implements EnginePathsPort {
  readonly held = new Map<string, Uint8Array>();
  windowed = false;
  free: number | undefined = undefined;
  pathOf(file: { role: string }) {
    return `/state/voice/models/kokoro/${file.role}`;
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

class FakeThread implements ReplyThread {
  readonly requests: ReplyCall[] = [];
  terminated = false;
  private ended: (() => void)[] = [];
  constructor(
    private readonly loadGate?: Promise<void>,
    private readonly failSpeak = false,
    private readonly failLoad = false,
  ) {}
  async call(request: ReplyCall) {
    this.requests.push(request);
    if (this.terminated) throw new Error('stopped');
    switch (request.kind) {
      case 'load':
        await this.loadGate;
        if (this.failLoad) throw new Error('the voice would not load');
        return { id: 1, ok: true as const, kind: 'load' as const, loadMs: 1700, memoryMb: 512 };
      case 'probe':
        return { id: 1, ok: true as const, kind: 'probe' as const, version: '2.0.3' };
      case 'release':
        return { id: 1, ok: true as const, kind: 'release' as const };
      case 'speak':
        if (this.failSpeak) throw new Error('speak crashed');
        // 16,000 samples = one second of sound, made in 3 s.
        return {
          id: 1,
          ok: true as const,
          kind: 'speak' as const,
          samples: new Float32Array(16_000).fill(0.1),
          speakMs: 3000,
        };
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
    failSpeak?: boolean;
    failLoad?: boolean;
  } = {},
) {
  const files = new Files();
  files.free = options.freeDisk;
  const hold: { gate?: Promise<void>; release?: () => void } = {};
  const threads: FakeThread[] = [];
  const timers: { delay: number; fn: () => void; cancelled: boolean }[] = [];
  const logged: string[] = [];
  const engine = new ReplyVoiceEngine({
    http: {
      request: async () =>
        options.fetchStatus !== undefined
          ? new Response('no', { status: options.fetchStatus })
          : new Response(options.tamper === true ? new TextEncoder().encode('voice fil!') : BODY),
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
      const thread = new FakeThread(hold.gate, options.failSpeak === true, options.failLoad === true);
      threads.push(thread);
      return thread;
    },
    availableMemory: () => ('memory' in options ? options.memory : TOTAL + REPLY_LOAD_HEADROOM_BYTES + 1),
    log: { info: message => void logged.push(message), warn: message => void logged.push(message) },
    catalog: CATALOG,
  });
  return { engine, files, threads, timers, logged, hold };
}

describe('the reply voice: the shipped catalog', () => {
  test('pins five files by size and hash, from the hosts the manifest declares', () => {
    expect(REPLY_FILES.map(file => file.role).sort()).toEqual([...REPLY_ROLES].sort());
    for (const file of REPLY_FILES) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(file.bytes).toBeGreaterThan(0);
      expect(['huggingface.co', 'cdn.jsdelivr.net']).toContain(new URL(file.url).hostname);
    }
    // Pinned to a commit and a version, never a moving name.
    expect(REPLY_FILES.find(file => file.role === 'model')?.url).toMatch(/\/resolve\/[0-9a-f]{40}\//u);
    expect(REPLY_FILES.find(file => file.role === 'runtime')?.url).toContain('sherpa-onnx@2.0.3');
    expect(REPLY_SPEAKER_ID).toBe(3);
  });
});

describe('the reply voice: install', () => {
  test('starts not installed, installs in the background, and is ready only after it spoke once; the proof leaves nothing loaded', async () => {
    const { engine, threads } = build();
    const empty = await engine.view();
    expect(ReplyVoiceViewSchema.parse(empty)).toMatchObject({
      state: 'not_installed',
      machine: 'Studio Mac',
      sizeBytes: TOTAL,
      doneBytes: 0,
      loaded: false,
    });
    expect((await engine.install()).state).toBe('installing');
    await engine.settled();
    const ready = ReplyVoiceViewSchema.parse(await engine.view());
    expect(ready).toMatchObject({ state: 'ready', doneBytes: TOTAL, loaded: false });
    expect(ready.selfTest).toEqual({ loadMs: 1700, speakMs: 3000, audioMs: 1000, realTimeFactor: 3, memoryMb: 512 });
    expect(threads[0]?.requests.map(request => request.kind)).toEqual(['load', 'speak']);
    expect(threads[0]?.terminated).toBe(true);
  });

  test('a self-test that fails leaves nothing loaded and says so', async () => {
    const { engine, threads } = build({ failSpeak: true });
    await engine.install();
    await engine.settled();
    expect((await engine.view()).state).toBe('failed');
    expect(threads[0]?.terminated).toBe(true);
  });

  test('too little free disk fails with no_disk and the installer’s own sentence, and downloads nothing', async () => {
    const { engine, files, threads } = build({ freeDisk: 5_000 });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.failure?.code).toBe('no_disk');
    expect(view.failure?.sentence).toContain('free disk space');
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

  test('a tampered download is refused (hash_mismatch) and nothing of it is kept', async () => {
    const { engine, files } = build({ tamper: true });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.failure?.code).toBe('hash_mismatch');
    expect(view.failure?.sentence).toContain('nothing was kept');
    expect(files.held.size).toBe(0);
  });

  test('an unreachable server fails with download_failed and says what to do', async () => {
    const { engine } = build({ fetchStatus: 503 });
    await engine.install();
    await engine.settled();
    expect((await engine.view()).failure).toMatchObject({ code: 'download_failed' });
  });
});

describe('the reply voice: use', () => {
  async function ready() {
    const built = build();
    await built.engine.install();
    await built.engine.settled();
    return built;
  }

  test('speaks with the one speaker, loading once however many lines', async () => {
    const { engine, threads } = await ready();
    const made = await engine.speak('Let me check.');
    expect(made.samples).toHaveLength(16_000);
    expect(made.speakMs).toBe(3000);
    await engine.speak('And again.');
    expect(threads).toHaveLength(2);
    expect(threads[1]?.requests.filter(request => request.kind === 'load')).toHaveLength(1);
    const speaks = threads[1]?.requests.filter(request => request.kind === 'speak') ?? [];
    expect(speaks).toEqual([
      { kind: 'speak', text: 'Let me check.', speaker: REPLY_SPEAKER_ID },
      { kind: 'speak', text: 'And again.', speaker: REPLY_SPEAKER_ID },
    ]);
  });

  test('the model is read by its path, never sent: only the runtime crosses to the worker', async () => {
    const { engine, threads } = await ready();
    await engine.warm();
    const load = threads[1]?.requests[0];
    expect(load).toMatchObject({
      kind: 'load',
      paths: {
        model: '/state/voice/models/kokoro/model',
        voices: '/state/voice/models/kokoro/voices',
        tokens: '/state/voice/models/kokoro/tokens',
        lexicon: '/state/voice/models/kokoro/lexicon',
      },
    });
    expect((await engine.view()).loaded).toBe(true);
  });

  test('is unloaded ten idle minutes after the last use, and loads again on the next', async () => {
    const { engine, timers, threads } = await ready();
    await engine.speak('One.');
    const last = timers.filter(timer => !timer.cancelled).at(-1);
    expect(last?.delay).toBe(REPLY_IDLE_UNLOAD);
    last?.fn();
    await Promise.resolve();
    expect(threads[1]?.terminated).toBe(true);
    expect((await engine.view()).loaded).toBe(false);
    await engine.speak('Two.');
    expect(threads).toHaveLength(3);
  });

  test('every use re-arms the idle timer', async () => {
    const { engine, timers } = await ready();
    await engine.speak('One.');
    const before = timers.filter(timer => !timer.cancelled).length;
    await engine.speak('Two.');
    expect(timers.filter(timer => !timer.cancelled)).toHaveLength(before);
  });

  test('a worker that dies is forgotten, so the next line starts a fresh one', async () => {
    const { engine, threads } = await ready();
    await engine.speak('One.');
    await threads[1]?.terminate();
    expect((await engine.view()).loaded).toBe(false);
    await engine.speak('Two.');
    expect(threads).toHaveLength(3);
  });

  test('refuses to load without the memory for it', async () => {
    const built = build({ memory: 1_000 });
    for (const file of CATALOG) built.files.held.set(file.role, BODY);
    await expect(built.engine.speak('One.')).rejects.toMatchObject({ code: 'no_memory' });
    expect(built.threads).toHaveLength(0);
  });

  test('before install it is not_ready and starts no thread; a half-installed set is not ready either', async () => {
    const { engine, threads, files } = build();
    await expect(engine.speak('One.')).rejects.toMatchObject({ code: 'not_ready' });
    files.held.set('runtime', BODY);
    await expect(engine.warm()).rejects.toMatchObject({ code: 'not_ready' });
    expect(threads).toHaveLength(0);
  });

  test('a runtime whose file vanished between the size check and the read is not_ready', async () => {
    const built = build();
    for (const file of CATALOG) built.files.held.set(file.role, BODY);
    built.files.read = async () => undefined;
    await expect(built.engine.warm()).rejects.toMatchObject({ code: 'not_ready' });
  });

  test('a catalog with no runtime line is not_ready', async () => {
    const files = new Files();
    for (const file of CATALOG) files.held.set(file.role, BODY);
    const engine = new ReplyVoiceEngine({
      http: { request: async () => new Response(BODY) },
      files,
      clock: { after: () => () => undefined },
      machine: () => 'm',
      start: () => new FakeThread(),
      availableMemory: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
      catalog: CATALOG.filter(file => file.role !== 'runtime'),
    });
    await expect(engine.warm()).rejects.toMatchObject({ code: 'not_ready' });
  });

  test('remove unloads, deletes every file, and refuses while installing', async () => {
    const { engine, files, threads } = await ready();
    await engine.speak('One.');
    expect(await engine.remove()).toMatchObject({ state: 'not_installed', doneBytes: 0, loaded: false });
    expect(files.held.size).toBe(0);
    expect(threads[1]?.terminated).toBe(true);
    const busy = build();
    await busy.engine.install();
    await expect(busy.engine.remove()).rejects.toBeInstanceOf(VoiceEngineError);
    await busy.engine.settled();
  });

  test('a speak reply of the wrong kind is a load failure, not a crash', async () => {
    const { engine, threads } = await ready();
    await engine.warm();
    const thread = threads[1] as FakeThread;
    thread.call = async () => ({ id: 1, ok: true as const, kind: 'load' as const, loadMs: 1, memoryMb: 1 });
    await expect(engine.speak('One.')).rejects.toMatchObject({ code: 'load_failed' });
  });
});

describe('the reply voice: loading', () => {
  test('a worker that cannot load is ended, and the caller is told load_failed', async () => {
    const built = build({ failLoad: true });
    for (const file of CATALOG) built.files.held.set(file.role, BODY);
    await expect(built.engine.speak('One.')).rejects.toMatchObject({ code: 'load_failed' });
    expect(built.threads[0]?.terminated).toBe(true);
    expect(built.logged).toContain('voice.reply.load_error');
    expect((await built.engine.view()).loaded).toBe(false);
  });

  test('bytes read as a window into a larger buffer are copied out before they are handed over', async () => {
    const built = build();
    for (const file of CATALOG) built.files.held.set(file.role, BODY);
    built.files.windowed = true;
    expect((await built.engine.speak('One.')).samples).toHaveLength(16_000);
  });
});

describe('the reply voice: a load that is overtaken', () => {
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

  test('unload during a load: the loading worker ends itself and nothing is published', async () => {
    const { engine, threads, hold } = await held();
    const call = engine.speak('One.').catch((error: unknown) => error);
    await flush();
    await engine.unload();
    hold.release?.();
    expect(await call).toMatchObject({ code: 'not_ready' });
    expect(threads[1]?.terminated).toBe(true);
    expect((await engine.view()).loaded).toBe(false);
  });

  test('an unload before the runtime is even read stops that load without starting a worker', async () => {
    const built = build();
    await built.engine.install();
    await built.engine.settled();
    const real = built.files.read.bind(built.files);
    built.files.read = async file => {
      await built.engine.unload();
      return await real(file);
    };
    await expect(built.engine.warm()).rejects.toMatchObject({ code: 'not_ready' });
    expect(built.threads).toHaveLength(1);
  });

  test('a call made after the unload starts ONE fresh load; the overtaken one cannot replace it', async () => {
    const { engine, threads, hold } = await held();
    const first = engine.speak('One.').catch((error: unknown) => error);
    await flush();
    await engine.unload();
    const second = engine.speak('Two.');
    await flush();
    expect(threads).toHaveLength(3);
    hold.release?.();
    expect(await first).toMatchObject({ code: 'not_ready' });
    expect((await second).samples).toHaveLength(16_000);
    expect(threads.map(thread => thread.terminated)).toEqual([true, true, false]);
  });
});
