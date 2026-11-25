import type { ChildHandle, Clock, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { RequestThread } from '../lib/engine/ports.ts';
import { encodeFrame, FrameError, FrameReader } from '../lib/native/frames.ts';
import { ChildStopped } from '../lib/native/stopped.ts';

/** The program a host child runs: the daemon's own executable, told which engine's worker to hold. */
export interface HostCommand {
  readonly program: string;
  readonly args: readonly string[];
}

export interface ChildThreadParts {
  readonly spawn: Pick<SpawnPort, 'start'>;
  readonly clock: Pick<Clock, 'after'>;
  readonly command: HostCommand;
  /** What the host is called in a sentence ("speech engine", "reply voice"). */
  readonly words: string;
}

/**
 * A DEADLINE ON EVERY CALL. A native call that has not answered by then is a stuck one: the host is killed rather than
 * waited on, and the turn fails with a sentence. They are generous next to what was measured (a Kokoro load 1.4-2 s, a
 * 5 s decode 0.3 s, a line spoken in 0.5 s) because the box may be loaded; they exist to bound a hang, not to race one.
 */
const DEADLINES_MS: Readonly<Record<string, number>> = {
  load: 180_000,
  probe: 30_000,
  transcribe: 120_000,
  detect: 120_000,
  speak: 60_000,
};
const DEFAULT_DEADLINE_MS = 60_000;

/** How long a host that was asked to end has before it is killed. */
const END_GRACE_MS = 2_000;

interface Waiting {
  readonly resolve: (reply: never) => void;
  readonly reject: (error: Error) => void;
  readonly cancel: () => void;
}

const SIGNALS: Readonly<Record<number, string>> = {
  4: 'SIGILL',
  6: 'SIGABRT',
  7: 'SIGBUS',
  9: 'SIGKILL',
  11: 'SIGSEGV',
};

/** What a host's exit says, in plain words (no signal names a person must decode alone). */
function endedWith(code: number | null): string {
  if (code === null) return 'it was ended by the system';
  const signal = SIGNALS[code > 128 ? code - 128 : code];
  if (code > 128 && signal !== undefined) return `it crashed (${signal})`;
  if (code === 137) return 'it was ended by the system, probably for lack of memory';
  return `it exited (code ${code})`;
}

/**
 * ONE NATIVE ENGINE'S HOST: a child process of the daemon that holds the engine's worker (and so the native library), spoken
 * to in frames over its stdin and stdout. A fault inside sherpa-onnx or onnxruntime ends that child and nothing else: every
 * call waiting on it fails with {@link ChildStopped} and a plain sentence, and the engine starts a new one at its next use.
 *
 * - SEALED, env `{}`: the host sees the nine names a sealed child inherits and nothing else, so no `LD_LIBRARY_PATH` or
 *   `DYLD_*` of the daemon's reaches the loader (the library finds its two neighbours by its own run-path).
 * - NO ORPHANS: the host reads its stdin and ends when it closes, so a daemon that is killed outright takes it along; an
 *   ordinary end is `terminate` (SIGTERM, then SIGKILL after a short grace), and a deadline or a frame it cannot read kills it.
 * - A host's stderr is read and thrown away: it may name paths and never what was said, and nothing here repeats it.
 */
export function startChildThread<Call extends { readonly kind: string }, Reply extends { readonly ok: true }>(
  parts: ChildThreadParts,
): RequestThread<Call, Reply> {
  const { clock, words } = parts;
  const child: ChildHandle = parts.spawn.start(parts.command.program, [...parts.command.args], {
    sealed: true,
    env: {},
  });
  const waiting = new Map<number, Waiting>();
  const ended: ((stopped?: string) => void)[] = [];
  let next = 1;
  let over = false;
  let wanted = false;
  let cancelKill: (() => void) | undefined;

  const finish = (reason: string | undefined): void => {
    if (over) return;
    over = true;
    cancelKill?.();
    const error = new ChildStopped(
      reason === undefined ? `The ${words} was stopped.` : `The ${words} stopped: ${reason}.`,
    );
    for (const [, pending] of waiting) {
      pending.cancel();
      pending.reject(error);
    }
    waiting.clear();
    for (const listener of ended) listener(reason);
  };
  /** The host did something it must not: it is ended, and what waited on it is told why. */
  const fail = (why: string): void => {
    finish(why);
    child.kill('SIGKILL');
  };

  const reader = new FrameReader();
  void (async () => {
    try {
      for await (const chunk of child.stdout) {
        for (const { message } of reader.push(chunk)) {
          const reply = message as { id?: unknown; ok?: unknown; sentence?: unknown };
          if (typeof reply.id !== 'number') continue;
          const pending = waiting.get(reply.id);
          if (pending === undefined) continue;
          waiting.delete(reply.id);
          pending.cancel();
          if (reply.ok === true) pending.resolve(message as never);
          else pending.reject(new Error(typeof reply.sentence === 'string' ? reply.sentence : `The ${words} failed.`));
        }
      }
    } catch (error) {
      if (error instanceof FrameError) fail('it sent something that could not be read');
    }
  })();
  void (async () => {
    // The host's stderr is read so its pipe never fills; none of it is kept.
    try {
      for await (const _ of child.stderr) void _;
    } catch {
      // closed
    }
  })();
  void child.exited.then(
    code => finish(wanted ? undefined : endedWith(code)),
    () => finish(wanted ? undefined : 'it stopped unexpectedly'),
  );

  return {
    call: (request, transfer) =>
      new Promise((resolve, reject) => {
        void transfer;
        if (over) {
          reject(new ChildStopped(`The ${words} stopped.`));
          return;
        }
        // A native host frees everything when it ends, so there is nothing to collect: the answer is immediate.
        if (request.kind === 'release') {
          resolve({ id: 0, ok: true, kind: 'release' } as unknown as Reply);
          return;
        }
        const id = next++;
        let frame: Uint8Array;
        try {
          frame = encodeFrame({ ...request, id });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const deadline = DEADLINES_MS[request.kind] ?? DEFAULT_DEADLINE_MS;
        const cancel = clock.after(milliseconds(deadline), () => {
          if (waiting.has(id)) fail(`it did not answer in ${Math.round(deadline / 1000)} seconds`);
        });
        waiting.set(id, { resolve: resolve as (reply: never) => void, reject, cancel });
        try {
          child.write(frame);
        } catch {
          fail('it could not be written to');
        }
      }),
    terminate: async () => {
      if (over) return;
      wanted = true;
      child.kill('SIGTERM');
      cancelKill = clock.after(milliseconds(END_GRACE_MS), () => child.kill('SIGKILL'));
      await child.exited.catch(() => undefined);
      finish(undefined);
    },
    onEnd: listener => void ended.push(listener),
  };
}
