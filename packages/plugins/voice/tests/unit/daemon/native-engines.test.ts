import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ReplyVoiceViewSchema, VoiceEngineError, VoiceEngineViewSchema } from '../../../contract/index.ts';
import type { EngineFile } from '../../../daemon/lib/engine/catalog.ts';
import { SpeechEngine } from '../../../daemon/lib/engine/engine.ts';
import type { EnginePathsPort, ReplyThread, SpeechThread } from '../../../daemon/lib/engine/ports.ts';
import { LOAD_ROLES, type SpeechCall } from '../../../daemon/lib/engine/protocol.ts';
import {
  NATIVE_ADDON_ROLE,
  NATIVE_MAX_THREADS,
  NATIVE_TARGETS,
  NATIVE_VERSION,
  type NativeParts,
  type NativeTarget,
  nativeTargetFor,
  nativeThreads,
} from '../../../daemon/lib/native/catalog.ts';
import { REPLY_FILES, REPLY_NATIVE_MODEL, REPLY_ROLES, type ReplyFile } from '../../../daemon/lib/reply/catalog.ts';
import { ReplyVoiceEngine } from '../../../daemon/lib/reply/engine.ts';
import type { ReplyCall } from '../../../daemon/lib/reply/protocol.ts';

/**
 * The native engine's install and load, for both engines, against fakes: the files are tiny, the threads are scripted, and
 * the HTTP server hands each URL its own bytes. What is proved is the DECISIONS (which files are fetched and when, which
 * engine runs, what is refused and what is kept), not sherpa-onnx: `tests/realworld/` proves that with the real library.
 */

const body = (text: string) => new TextEncoder().encode(text);
const pin = (role: string, text: string, host = 'huggingface.co'): EngineFile & { readonly text: string } => ({
  role,
  label: role,
  // The text is part of the address: the reply voice and the speech engine each have a `tokens`, and they are not one file.
  url: `https://${host}/x/${role}/${createHash('sha256').update(text).digest('hex').slice(0, 8)}`,
  bytes: body(text).byteLength,
  sha256: createHash('sha256').update(body(text)).digest('hex'),
  text,
});

const TARGET: NativeTarget = {
  key: 'test-x64',
  files: [
    pin(NATIVE_ADDON_ROLE, 'the addon', 'cdn.jsdelivr.net'),
    pin('libsherpa-onnx-c-api.so', 'the c api', 'cdn.jsdelivr.net'),
    pin('libonnxruntime.so', 'the runtime', 'cdn.jsdelivr.net'),
  ],
};
const bodies = new Map<string, string>();
const served = (file: EngineFile & { readonly text?: string }): EngineFile => {
  bodies.set(file.url, (file as { text: string }).text);
  return file;
};
for (const file of TARGET.files) served(file);

const REPLY_CATALOG: readonly ReplyFile[] = REPLY_ROLES.map(role => served(pin(role, `reply ${role}`)) as ReplyFile);
const REPLY_FP32 = served({ ...pin('model-fp32', 'reply fp32'), role: 'model-fp32' }) as ReplyFile;
const SPEECH_CATALOG: readonly EngineFile[] = LOAD_ROLES.map(role => served(pin(role, `speech ${role}`)));

class Files implements EnginePathsPort {
  readonly held = new Map<string, Uint8Array>();
  free: number | undefined = undefined;
  pathOf(file: { role: string }) {
    return `/state/voice/models/test/${file.role}`;
  }
  async freeBytes() {
    return this.free;
  }
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
  has(role: string): boolean {
    return this.held.has(role);
  }
}

/** What a scripted thread does when asked to probe or to load natively. */
interface Script {
  probeFails?: boolean;
  nativeLoadFails?: boolean;
  nativeSpeakFails?: boolean;
}

function server(options: { tamper?: string } = {}) {
  const requested: string[] = [];
  return {
    requested,
    http: {
      request: async (url: string) => {
        requested.push(url);
        const text = bodies.get(url);
        if (text === undefined) return new Response('no', { status: 404 });
        return new Response(
          options.tamper !== undefined && url.includes(`/${options.tamper}/`) ? body('forged!!') : body(text),
        );
      },
    },
  };
}

const nativeParts = (target: NativeTarget | undefined, threads = 4): NativeParts => ({
  target,
  threads: () => threads,
  platform: 'test-x64',
});

class ReplyThreadFake implements ReplyThread {
  terminated = false;
  private ended: (() => void)[] = [];
  constructor(
    readonly requests: ReplyCall[],
    private readonly script: Script,
  ) {}
  async call(request: ReplyCall) {
    this.requests.push(request);
    if (this.terminated) throw new Error('stopped');
    switch (request.kind) {
      case 'probe':
        if (this.script.probeFails) throw new Error('libstdc++.so.6: cannot open shared object file');
        return { id: 1, ok: true as const, kind: 'probe' as const, version: NATIVE_VERSION };
      case 'release':
        return { id: 1, ok: true as const, kind: 'release' as const };
      case 'load':
        if (request.engine === 'native' && this.script.nativeLoadFails) throw new Error('the graph would not build');
        return {
          id: 1,
          ok: true as const,
          kind: 'load' as const,
          loadMs: 900,
          memoryMb: request.engine === 'native' ? 400 : 512,
        };
      case 'speak':
        return {
          id: 1,
          ok: true as const,
          kind: 'speak' as const,
          samples: new Float32Array(16_000).fill(0.1),
          speakMs: 300,
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

function replyEngine(
  options: {
    script?: Script;
    target?: NativeTarget | undefined;
    threads?: number;
    tamper?: string;
    free?: number;
    files?: Files;
  } = {},
) {
  const files = options.files ?? new Files();
  files.free = options.free;
  const net = server(options.tamper === undefined ? {} : { tamper: options.tamper });
  const requests: ReplyCall[] = [];
  const logged: string[] = [];
  const engine = new ReplyVoiceEngine({
    http: net.http,
    files,
    machine: () => 'Studio Mac',
    clock: { after: () => () => undefined },
    start: () => new ReplyThreadFake(requests, options.script ?? {}),
    availableMemory: () => undefined,
    log: { info: m => void logged.push(m), warn: m => void logged.push(m) },
    catalog: REPLY_CATALOG,
    nativeModel: REPLY_FP32,
    native: nativeParts('target' in options ? options.target : TARGET, options.threads),
  });
  return { engine, files, requested: net.requested, requests, logged };
}

const SHARED = ['voices', 'tokens', 'lexicon'];
const total = (list: readonly EngineFile[]): number => list.reduce((sum, file) => sum + file.bytes, 0);

describe('the native catalog', () => {
  test('pins every target: three files, from the CDN, at the one version, by size and SHA-256', () => {
    expect(NATIVE_TARGETS.map(target => target.key)).toEqual(['linux-x64', 'linux-arm64', 'darwin-arm64']);
    for (const target of NATIVE_TARGETS) {
      expect(target.files).toHaveLength(3);
      expect(target.files[0]?.role).toBe(NATIVE_ADDON_ROLE);
      for (const file of target.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(file.bytes).toBeGreaterThan(100_000);
        expect(file.url).toBe(`https://cdn.jsdelivr.net/npm/sherpa-onnx-${target.key}@${NATIVE_VERSION}/${file.role}`);
        // The loader finds the libraries by their own names, so a role is a bare file name.
        expect(file.role).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u);
      }
    }
  });

  test('the native version is the WebAssembly runtime’s version: one pin of sherpa-onnx, not two', () => {
    expect(REPLY_FILES.find(file => file.role === 'runtime')?.url).toContain(`sherpa-onnx@${NATIVE_VERSION}/`);
  });

  test('a platform with no pinned library has no target, and the thread budget is four at most and never every core', () => {
    expect(nativeTargetFor('linux', 'x64')?.key).toBe('linux-x64');
    expect(nativeTargetFor('win32', 'x64')).toBeUndefined();
    expect(nativeTargetFor('linux', 'riscv64')).toBeUndefined();
    expect([1, 2, 3, 4, 5, 8, 32, 128].map(nativeThreads)).toEqual([1, 1, 2, 3, 4, 4, 4, 4]);
    expect(NATIVE_MAX_THREADS).toBe(4);
  });

  test('the fp32 reply model is pinned to a commit, and is the file the speed measurement used', () => {
    expect(REPLY_NATIVE_MODEL.url).toMatch(/\/resolve\/[0-9a-f]{40}\/model\.onnx$/u);
    expect(REPLY_NATIVE_MODEL.sha256).toBe('b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11');
  });
});

describe('the reply voice, native first', () => {
  test('installs the library, proves it loads, then the fp32 model; never fetches the WebAssembly files', async () => {
    const { engine, files, requested, requests } = replyEngine();
    expect((await engine.view()).sizeBytes).toBe(
      total([...REPLY_CATALOG.filter(f => SHARED.includes(f.role)), REPLY_FP32, ...TARGET.files]),
    );
    await engine.install();
    await engine.settled();
    const view = ReplyVoiceViewSchema.parse(await engine.view());
    expect(view.state).toBe('ready');
    expect(view.runtime).toMatchObject({ kind: 'native', threads: 4 });
    expect(view.runtime?.sentence).toContain('native engine');
    // The library comes first and is tried before the 326 MB model is downloaded.
    expect(requested.slice(0, 3)).toEqual(TARGET.files.map(file => file.url));
    // The proof is not a use: the voice is unloaded at once, and a native one is asked to free its models before its thread ends.
    expect(requests.map(r => r.kind)).toEqual(['probe', 'load', 'speak', 'release']);
    expect(requested).not.toContain(REPLY_CATALOG.find(f => f.role === 'model')?.url);
    expect(requested).not.toContain(REPLY_CATALOG.find(f => f.role === 'runtime')?.url);
    expect(files.has('model')).toBe(false);
    expect(files.has('runtime')).toBe(false);
    expect(files.has('model-fp32')).toBe(true);
    expect(view.sizeBytes).toBe(view.doneBytes);
    expect(view.runtime?.upgradeBytes).toBeUndefined();
  });

  test('loads by path with the thread budget, and speaks through the native engine', async () => {
    const { engine, requests } = replyEngine({ threads: 3 });
    await engine.install();
    await engine.settled();
    requests.length = 0;
    const spoken = await engine.speak('hello');
    expect(spoken.samples.length).toBe(16_000);
    const load = requests.find(r => r.kind === 'load');
    expect(load).toMatchObject({
      engine: 'native',
      threads: 3,
      addon: `/state/voice/models/test/${NATIVE_ADDON_ROLE}`,
      paths: { model: '/state/voice/models/test/model-fp32' },
    });
    expect(load).not.toHaveProperty('runtime');
  });

  test('an idle or removed native voice frees its models before its thread ends; a WebAssembly one has nothing to free', async () => {
    const native = replyEngine();
    await native.engine.install();
    await native.engine.settled();
    native.requests.length = 0;
    await native.engine.speak('hello');
    await native.engine.unload();
    expect(native.requests.map(r => r.kind)).toEqual(['load', 'speak', 'release']);
    const wasm = replyEngine({ target: undefined });
    await wasm.engine.install();
    await wasm.engine.settled();
    wasm.requests.length = 0;
    await wasm.engine.speak('hello');
    await wasm.engine.unload();
    expect(wasm.requests.map(r => r.kind)).toEqual(['load', 'speak']);
  });

  test('a library that will not load is learned before the model is downloaded, and the install ends on WebAssembly with the reason', async () => {
    const { engine, files, requested, requests } = replyEngine({ script: { probeFails: true } });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.state).toBe('ready');
    expect(view.runtime?.kind).toBe('wasm');
    expect(view.runtime?.threads).toBe(1);
    expect(view.runtime?.sentence).toContain('could not start');
    expect(view.runtime?.sentence).toContain('libstdc++.so.6');
    expect(view.runtime?.upgradeBytes).toBeUndefined();
    expect(requested).not.toContain(REPLY_FP32.url);
    expect(requested).toContain(REPLY_CATALOG.find(f => f.role === 'model')?.url as string);
    // The native files are not kept: a restart must not try them again.
    for (const file of TARGET.files) expect(files.has(file.role)).toBe(false);
    expect(view.sizeBytes).toBe(total(REPLY_CATALOG));
    await engine.speak('hello');
    expect(requests.filter(r => r.kind === 'load').map(r => (r as { engine: string }).engine)).toEqual([
      'wasm',
      'wasm',
    ]);
  });

  test('a library that loads but cannot speak also ends on WebAssembly, and the fp32 model it downloaded is deleted', async () => {
    const { engine, files, requests } = replyEngine({ script: { nativeLoadFails: true } });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.state).toBe('ready');
    expect(view.runtime?.kind).toBe('wasm');
    expect(view.runtime?.sentence).toContain('the graph would not build');
    expect(files.has('model-fp32')).toBe(false);
    expect(requests.map(r => (r.kind === 'load' ? `load:${r.engine}` : r.kind))).toEqual([
      'probe',
      'load:native',
      'load:wasm',
      'speak',
    ]);
  });

  test('a library that is not the pinned file is refused, nothing of it kept, and the install does NOT quietly run WebAssembly', async () => {
    const { engine, files, requests } = replyEngine({ tamper: NATIVE_ADDON_ROLE });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('hash_mismatch');
    expect([...files.held.keys()]).toEqual([]);
    expect(requests).toEqual([]);
  });

  test('a library that was changed on disk after it was saved is not loaded, is deleted, and the voice falls back or says to install again', async () => {
    const native = replyEngine();
    await native.engine.install();
    await native.engine.settled();
    // Same length, different bytes: a size check would not see it. A daemon that starts later hashes the files before it loads.
    native.files.held.set('libonnxruntime.so', body('the runtimX'));
    const later = replyEngine({ files: native.files });
    await expect(later.engine.speak('hello')).rejects.toBeInstanceOf(VoiceEngineError);
    expect(native.files.has('libonnxruntime.so')).toBe(false);
    expect(later.requests.filter(r => r.kind === 'load')).toHaveLength(0);
    expect((await later.engine.view()).state).toBe('not_installed');

    // With the WebAssembly files there as well (a voice whose native files went bad), it carries on with them.
    const both = replyEngine();
    await both.engine.install();
    await both.engine.settled();
    expect((await both.engine.view()).runtime?.kind).toBe('native');
    for (const file of REPLY_CATALOG) both.files.held.set(file.role, body(`reply ${file.role}`));
    both.files.held.set('libonnxruntime.so', body('the runtimX'));
    const restarted = replyEngine({ files: both.files });
    await restarted.engine.speak('hello');
    expect((await restarted.engine.view()).runtime?.kind).toBe('wasm');
  });

  test('a machine with no native build runs WebAssembly, downloads only its files, and says which machine it is', async () => {
    const { engine, requested } = replyEngine({ target: undefined });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.state).toBe('ready');
    expect(view.runtime?.kind).toBe('wasm');
    expect(view.runtime?.sentence).toContain('no native engine for test-x64');
    expect(view.runtime?.upgradeBytes).toBeUndefined();
    expect(requested.sort()).toEqual(REPLY_CATALOG.map(file => file.url).sort());
    expect(view.sizeBytes).toBe(total(REPLY_CATALOG));
  });

  test('the free-disk check counts the whole native plan before anything is downloaded', async () => {
    const { engine, requested } = replyEngine({ free: 10 });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('no_disk');
    expect(view.failure?.sentence).toContain('free disk space');
    expect(requested).toEqual([]);
  });

  test('a voice installed on WebAssembly can be upgraded: it says what that costs, and Install swaps the files', async () => {
    const { engine, files, requested } = replyEngine();
    for (const file of REPLY_CATALOG) files.held.set(file.role, body(`reply ${file.role}`));
    const before = await engine.view();
    expect(before.state).toBe('ready');
    expect(before.runtime?.kind).toBe('wasm');
    expect(before.runtime?.upgradeBytes).toBe(total([REPLY_FP32, ...TARGET.files]));
    expect(before.runtime?.sentence).toContain('can be installed');
    await engine.install();
    await engine.settled();
    const after = await engine.view();
    expect(after.runtime).toMatchObject({ kind: 'native' });
    expect(after.runtime?.upgradeBytes).toBeUndefined();
    // Only what was missing was fetched, and the WebAssembly model and runtime are dead weight once native runs.
    expect(requested).not.toContain(REPLY_CATALOG.find(f => f.role === 'model')?.url);
    expect(files.has('model')).toBe(false);
    expect(files.has('runtime')).toBe(false);
    expect(files.has('voices')).toBe(true);
  });

  test('Remove deletes the native files with the models', async () => {
    const { engine, files } = replyEngine();
    await engine.install();
    await engine.settled();
    expect(files.has(NATIVE_ADDON_ROLE)).toBe(true);
    const removed = await engine.remove();
    expect(removed.state).toBe('not_installed');
    expect([...files.held.keys()]).toEqual([]);
  });
});

class SpeechThreadFake implements SpeechThread {
  terminated = false;
  private ended: (() => void)[] = [];
  constructor(
    readonly requests: SpeechCall[],
    private readonly script: Script,
  ) {}
  async call(request: SpeechCall) {
    this.requests.push(request);
    if (this.terminated) throw new Error('stopped');
    switch (request.kind) {
      case 'probe':
        if (this.script.probeFails) throw new Error('libstdc++.so.6: cannot open shared object file');
        return { id: 1, ok: true as const, kind: 'probe' as const, version: NATIVE_VERSION };
      case 'release':
        return { id: 1, ok: true as const, kind: 'release' as const };
      case 'load':
        if (request.engine === 'native' && this.script.nativeLoadFails) throw new Error('the graph would not build');
        return {
          id: 1,
          ok: true as const,
          kind: 'load' as const,
          loadMs: 1500,
          memoryMb: request.engine === 'native' ? 900 : 1800,
        };
      case 'transcribe':
        return { id: 1, ok: true as const, kind: 'transcribe' as const, text: 'hello', decodeMs: 100 };
      case 'detect':
        return { id: 1, ok: true as const, kind: 'detect' as const, spans: [] };
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

function speechEngine(options: { script?: Script; target?: NativeTarget | undefined; tamper?: string } = {}) {
  const files = new Files();
  const net = server(options.tamper === undefined ? {} : { tamper: options.tamper });
  const requests: SpeechCall[] = [];
  const engine = new SpeechEngine({
    http: net.http,
    files,
    machine: () => 'Studio Mac',
    clock: { after: () => () => undefined },
    start: () => new SpeechThreadFake(requests, options.script ?? {}),
    availableMemory: () => undefined,
    log: { info: () => undefined, warn: () => undefined },
    catalog: SPEECH_CATALOG,
    native: nativeParts('target' in options ? options.target : TARGET),
  });
  return { engine, files, requested: net.requested, requests };
}

describe('the speech engine, native first', () => {
  test('installs the library first, never the WebAssembly runtime, and loads the three graphs by path', async () => {
    const { engine, files, requested, requests } = speechEngine();
    const fresh = await engine.view();
    expect(fresh.sizeBytes).toBe(
      total([...SPEECH_CATALOG.filter(file => file.role !== 'sherpa-wasm'), ...TARGET.files]),
    );
    await engine.install();
    await engine.settled();
    const view = VoiceEngineViewSchema.parse(await engine.view());
    expect(view.state).toBe('ready');
    expect(view.runtime).toMatchObject({ kind: 'native', threads: 4 });
    expect(requested.slice(0, 3)).toEqual(TARGET.files.map(file => file.url));
    expect(requested).not.toContain(SPEECH_CATALOG.find(f => f.role === 'sherpa-wasm')?.url as string);
    expect(files.has('sherpa-wasm')).toBe(false);
    expect(requests.map(r => r.kind)).toEqual(['probe', 'load', 'transcribe', 'release']);
    const load = requests.find(r => r.kind === 'load');
    expect(load).toMatchObject({
      engine: 'native',
      threads: 4,
      paths: {
        encoder: '/state/voice/models/test/encoder',
        decoder: '/state/voice/models/test/decoder',
        joiner: '/state/voice/models/test/joiner',
        tokens: '/state/voice/models/test/tokens',
      },
    });
    // Only Silero's two small files are sent as bytes: the big graphs are not read into the daemon at all.
    expect(Object.keys((load as { files: object }).files).sort()).toEqual(['ort-wasm', 'vad']);
    expect((await engine.transcribe(new Float32Array(16_000))).text).toBe('hello');
  });

  test('a library that will not load ends on WebAssembly with the WebAssembly runtime fetched and every graph sent as bytes', async () => {
    const { engine, files, requests } = speechEngine({ script: { probeFails: true } });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.runtime?.kind).toBe('wasm');
    expect(view.runtime?.sentence).toContain('could not start');
    for (const file of TARGET.files) expect(files.has(file.role)).toBe(false);
    expect(files.has('sherpa-wasm')).toBe(true);
    const load = requests.find(r => r.kind === 'load');
    expect(load).toMatchObject({ engine: 'wasm' });
    expect(Object.keys((load as { files: object }).files).sort()).toEqual([...LOAD_ROLES].sort());
  });

  test('a library that is not the pinned file is refused and nothing of it is kept', async () => {
    const { engine, files } = speechEngine({ tamper: 'libonnxruntime.so' });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('hash_mismatch');
    expect(files.has('libonnxruntime.so')).toBe(false);
    expect(files.has('encoder')).toBe(false);
  });

  test('a machine with no native build is exactly the WebAssembly engine it was', async () => {
    const { engine, requests } = speechEngine({ target: undefined });
    await engine.install();
    await engine.settled();
    const view = await engine.view();
    expect(view.runtime?.kind).toBe('wasm');
    expect(view.runtime?.sentence).toContain('no native engine for test-x64');
    expect(requests.map(r => r.kind)).toEqual(['load', 'transcribe']);
  });
});
