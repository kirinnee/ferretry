import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '@ferretry/kernel/testing';
import { startChildThread } from '../../../daemon/adapters/child-speech-thread.ts';
import { nativeHostCommand } from '../../../daemon/adapters/worker-speech-thread.ts';
import type { EngineFile } from '../../../daemon/lib/engine/catalog.ts';
import type { EnginePathsPort, ReplyThread } from '../../../daemon/lib/engine/ports.ts';
import type { ReplyCall } from '../../../daemon/lib/reply/protocol.ts';
import { encodeFrame, MAX_FRAME_BYTES } from '../../../daemon/lib/native/frames.ts';
import { NATIVE_ADDON_ROLE, type NativeTarget } from '../../../daemon/lib/native/catalog.ts';
import { ChildStopped } from '../../../daemon/lib/native/stopped.ts';
import { REPLY_ROLES, type ReplyFile } from '../../../daemon/lib/reply/catalog.ts';
import { ReplyVoiceEngine } from '../../../daemon/lib/reply/engine.ts';
import { processSpawn } from '../../support/daemon/process-spawn.ts';

/**
 * THE NATIVE SPEECH HOST AS A CHILD PROCESS (docs/design/voice-modes.md §2.3.1): a REAL child (a fake host that can kill
 * itself with SIGSEGV in the middle of a call, hang, or print noise) behind the real adapter and the real reply engine. What
 * is proved: a fault in the host's native code ends the host and nothing else, the call that was waiting fails with a plain
 * sentence, the next use starts a new host, three stops in a row give the engine up for WebAssembly, a host that does not
 * answer is killed at its deadline, and no host outlives its engine or its daemon.
 */
const FAKE_HOST = fileURLToPath(new URL('../../support/daemon/fake-speech-host.ts', import.meta.url));
const spawns = processSpawn();
const command = { program: process.execPath, args: [FAKE_HOST, 'reply'] };
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number): Promise<boolean> => {
  for (let tries = 0; tries < 100; tries += 1) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return false;
};
const hostThread = (clock = fixedClock()) =>
  startChildThread<ReplyCall & { kind: string }, { ok: true; kind: string }>({
    spawn: spawns,
    clock,
    command,
    words: 'reply voice',
  });

afterAll(() => {
  for (const pid of spawns.pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
});

describe('the child thread', () => {
  test('answers a call with its frames, audio included, and ends the host when asked', async () => {
    const thread = hostThread();
    const reply = (await thread.call({ kind: 'speak', text: 'hello', speaker: 0 } as never)) as unknown as {
      samples: Float32Array;
      pid: number;
    };
    expect(reply.samples).toBeInstanceOf(Float32Array);
    expect(reply.samples.length).toBe(160);
    expect(reply.samples[0]).toBe(0.25);
    await thread.terminate();
    expect(await gone(reply.pid)).toBe(true);
  });

  test('a SEGV in the middle of a call fails that call with a plain sentence, and the daemon (this process) lives', async () => {
    const thread = hostThread();
    const stops: (string | undefined)[] = [];
    thread.onEnd(stopped => void stops.push(stopped));
    const first = (await thread.call({ kind: 'speak', text: 'fine', speaker: 0 } as never)) as unknown as {
      pid: number;
    };
    const failure = await thread.call({ kind: 'speak', text: 'SEGV now', speaker: 0 } as never).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ChildStopped);
    expect((failure as Error).message).toMatch(/^The reply voice stopped: it crashed \(SIGSEGV\)\.$/u);
    expect(stops).toEqual(['it crashed (SIGSEGV)']);
    expect(await gone(first.pid)).toBe(true);
    // A thread that has ended answers at once, never waits.
    await expect(thread.call({ kind: 'speak', text: 'again', speaker: 0 } as never)).rejects.toBeInstanceOf(
      ChildStopped,
    );
  });

  test('an abort and a plain exit are told apart in words', async () => {
    for (const [text, words] of [
      ['ABORT', /SIGABRT/u],
      ['EXIT', /exited \(code 3\)/u],
    ] as const) {
      const thread = hostThread();
      const failure = (await thread
        .call({ kind: 'speak', text, speaker: 0 } as never)
        .catch((e: unknown) => e)) as Error;
      expect(failure.message).toMatch(words);
    }
  });

  test('a host that stops answering is killed at the deadline, not waited on', async () => {
    const clock = fixedClock();
    const thread = hostThread(clock);
    const warm = (await thread.call({ kind: 'load', engine: 'native' } as never)) as unknown as { pid: number };
    const waiting = thread.call({ kind: 'speak', text: 'HANG', speaker: 0 } as never).catch((e: unknown) => e);
    await Bun.sleep(100);
    await clock.advance(61_000);
    const failure = (await waiting) as Error;
    expect(failure).toBeInstanceOf(ChildStopped);
    expect(failure.message).toMatch(/did not answer in 60 seconds/u);
    expect(await gone(warm.pid)).toBe(true);
  });

  test('bytes that are not a frame end the host: the stream cannot be trusted to find the next frame', async () => {
    const thread = hostThread();
    const warm = (await thread.call({ kind: 'load', engine: 'native' } as never)) as unknown as { pid: number };
    const failure = (await thread
      .call({ kind: 'speak', text: 'NOISE', speaker: 0 } as never)
      .catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/could not be read/u);
    expect(await gone(warm.pid)).toBe(true);
  });

  test('a request over the frame bound is refused before it is sent, and the host is not hurt', async () => {
    const thread = hostThread();
    const huge = new Float32Array(MAX_FRAME_BYTES / 4 + 1);
    expect(() => encodeFrame({ samples: huge })).toThrow(/more than one message/u);
    await expect(thread.call({ kind: 'transcribe', samples: huge } as never)).rejects.toThrow(/more than one message/u);
    const ok = (await thread.call({ kind: 'speak', text: 'still here', speaker: 0 } as never)) as unknown as {
      pid: number;
    };
    expect(alive(ok.pid)).toBe(true);
    await thread.terminate();
  });

  test('releasing is answered at once: a process that ends frees everything, so there is nothing to collect', async () => {
    const thread = hostThread();
    expect(await thread.call({ kind: 'release' } as never)).toMatchObject({ ok: true, kind: 'release' });
    await thread.terminate();
  });

  test('a host whose daemon is gone (its stdin closed) ends itself: no orphan', async () => {
    const child = Bun.spawn([process.execPath, FAKE_HOST, 'reply'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    spawns.pids.push(child.pid);
    child.stdin.write(encodeFrame({ id: 1, kind: 'probe' }));
    child.stdin.flush();
    await child.stdout.getReader().read();
    child.stdin.end();
    expect(await Promise.race([child.exited, Bun.sleep(5000).then(() => 'still running')])).toBe(0);
  });
});

// ─── the reply engine over a real host ──────────────────────────────────────────────────────────────────────────────

const body = (text: string) => new TextEncoder().encode(text);
const pin = (role: string): EngineFile => ({
  role,
  label: role,
  url: `https://example.test/${role}`,
  bytes: body(role).byteLength,
  sha256: createHash('sha256').update(body(role)).digest('hex'),
});
const TARGET: NativeTarget = {
  key: 'test-x64',
  files: [pin(NATIVE_ADDON_ROLE), pin('libsherpa-onnx-c-api.so'), pin('libonnxruntime.so')],
};
const CATALOG = REPLY_ROLES.map(role => pin(role)) as unknown as readonly ReplyFile[];
const NATIVE_MODEL = pin('model-fp32') as unknown as ReplyFile;

class Files implements EnginePathsPort {
  readonly held = new Map<string, Uint8Array>(
    [...TARGET.files, ...CATALOG, NATIVE_MODEL].map(file => [file.role, body(file.role)]),
  );
  pathOf = (file: { role: string }) => `/state/${file.role}`;
  freeBytes = async () => undefined;
  size = async (file: { role: string }) => this.held.get(file.role)?.byteLength;
  read = async (file: { role: string }) => this.held.get(file.role)?.slice();
  write = async (file: { role: string }, bytes: Uint8Array) => void this.held.set(file.role, bytes);
  remove = async (file: { role: string }) => void this.held.delete(file.role);
}

/** A WebAssembly worker thread, scripted: it speaks, and says so. */
const wasmThread = (): ReplyThread => ({
  call: async request =>
    request.kind === 'load'
      ? ({ id: 1, ok: true, kind: 'load', loadMs: 1, memoryMb: 1 } as never)
      : ({ id: 1, ok: true, kind: 'speak', samples: new Float32Array(16).fill(0.5), speakMs: 1 } as never),
  terminate: async () => undefined,
  onEnd: () => undefined,
});

function engineOverHost() {
  const started: string[] = [];
  const logged: string[] = [];
  const engine = new ReplyVoiceEngine({
    http: { request: async () => new Response('no', { status: 404 }) },
    files: new Files(),
    machine: () => 'Studio Mac',
    clock: fixedClock(),
    start: kind => {
      started.push(kind);
      return kind === 'native' ? (hostThread() as unknown as ReplyThread) : wasmThread();
    },
    availableMemory: () => undefined,
    log: { info: m => void logged.push(m), warn: m => void logged.push(m) },
    catalog: CATALOG,
    nativeModel: NATIVE_MODEL,
    native: { target: TARGET, threads: () => 4, platform: 'test-x64' },
  });
  return { engine, started, logged };
}

const pidOf = (spoken: { readonly samples: Float32Array }): number => {
  void spoken;
  return spawns.pids.at(-1) ?? 0;
};

describe('the reply voice over a native host that crashes', () => {
  test('a crash mid-speak fails that line cleanly, says it stopped, and the next line starts a new host', async () => {
    const { engine, started } = engineOverHost();
    const first = await engine.speak('hello there');
    const firstPid = pidOf(first);
    expect((await engine.view()).runtime?.kind).toBe('native');

    // The fault: the host kills itself in the middle of speaking. Only this line fails.
    await expect(engine.speak('SEGV')).rejects.toThrow(/stopped: it crashed \(SIGSEGV\)/u);
    expect(await gone(firstPid)).toBe(true);
    const stopped = await engine.view();
    expect(stopped.runtime?.kind).toBe('native');
    expect(stopped.runtime?.sentence).toMatch(/stopped on Studio Mac: it crashed \(SIGSEGV\)\. It starts again/u);

    // The next use respawns: a new host, a new pid, the same engine; and it says it is running again.
    const again = await engine.speak('back again');
    expect(again.samples.length).toBe(160);
    expect(pidOf(again)).not.toBe(firstPid);
    expect(started).toEqual(['native', 'native']);
    expect((await engine.view()).runtime?.sentence).not.toMatch(/stopped on/u);
    await engine.unload();
    expect(await gone(pidOf(again))).toBe(true);
  });

  test('three stops in a row give the native voice up for WebAssembly, with the reason said', async () => {
    const { engine, started } = engineOverHost();
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(engine.speak('SEGV')).rejects.toThrow(/stopped/u);
    // The third stop was the last allowed: the voice that speaks next is the WebAssembly one.
    const spoken = await engine.speak('now on the slower voice');
    expect(spoken.samples.length).toBe(16);
    expect(started).toEqual(['native', 'native', 'native', 'wasm']);
    const view = await engine.view();
    expect(view.runtime?.kind).toBe('wasm');
    expect(view.runtime?.sentence).toMatch(
      /could not start on Studio Mac \(it stopped 3 times in a row; the last time it crashed \(SIGSEGV\)\)/u,
    );
  });

  test('a stop that is followed by an answered call does not count toward the three', async () => {
    const { engine, started } = engineOverHost();
    for (let round = 0; round < 4; round += 1) {
      await expect(engine.speak('SEGV')).rejects.toThrow(/stopped/u);
      await engine.speak('it works again');
    }
    expect(started.every(kind => kind === 'native')).toBe(true);
    await engine.unload();
  });
});

describe('the real host program', () => {
  test('speech-host runs the real speech worker in a child and answers for an addon it cannot load, in words', async () => {
    const thread = startChildThread<{ kind: string }, { ok: true; kind: string }>({
      spawn: spawns,
      clock: fixedClock(),
      command: nativeHostCommand('speech'),
      words: 'speech engine',
    });
    const failure = (await thread
      .call({ kind: 'probe', addon: '/nonexistent/sherpa-onnx.node' } as never)
      .catch((error: unknown) => error)) as Error;
    // An ordinary failure of the library to load is an answer, not a stop: the host is still there to be ended on purpose.
    expect(failure).not.toBeInstanceOf(ChildStopped);
    expect(failure.message).toMatch(/could not probe/u);
    await thread.terminate();
  }, 30_000);
});
