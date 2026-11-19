/**
 * Running one package manager for a tool install.
 *
 * The service decides WHAT runs, from its declared table; this adapter only runs it, and is shaped so a run can neither
 * wait on a person, outlive its deadline, nor leave anything running behind it:
 *
 * - **An argv array and no shell.** The executable is the absolute manager path the service located; `sudo` is not a
 *   program this plugin may start (its manifest names `brew` and `npm` only).
 * - **stdin is closed at once, never written.** A manager that wants a password or a yes reads end-of-file and fails, which the service reads
 *   as 'needs admin' and answers with a command for a person.
 * - **The manager leads its own process group, and the whole group is killed** when the run ends, by deadline or by the
 *   manager exiting: an npm `postinstall` or a cask's helper that kept going would otherwise keep changing the install
 *   prefix after the service released its one-install guard. The run returns only after that cleanup.
 * - **Only a bounded tail of output is kept**, from stdout and stderr alike, bounded in BYTES before anything is decoded:
 *   a line is cut at {@link LINE_BYTES}, the tail holds {@link TAIL_LINES} lines and {@link TAIL_BYTES} bytes, so a
 *   stream with no newline, or forty enormous lines, cannot grow it.
 * - **Both readers are stopped** (cancelled) once the run is over, so no pipe reader outlives the call.
 */
import type { ChildHandle, Clock, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { PackageInstallPort } from '../lib/service/tool-install.ts';

/** How many trailing lines are kept for classifying a failure. */
const TAIL_LINES = 40;

/** One kept line is cut here, in bytes, before it is decoded. */
const LINE_BYTES = 1_024;

/** The whole kept tail never holds more than this many bytes. */
const TAIL_BYTES = 16_384;

/** How long the readers may finish after the group is killed, for a pipe something outside the group still holds. */
const DRAIN_GRACE_MS = 1_000;

/** How long a killed manager is waited for. A SIGKILLed process ends at once unless the kernel is stuck on it. */
const EXIT_GRACE_MS = 5_000;

const NEWLINE = 0x0a;

/** The kept tail: complete lines, each at most {@link LINE_BYTES}, the lot at most {@link TAIL_BYTES}. */
class Tail {
  readonly #lines: { readonly text: string; readonly bytes: number }[] = [];
  #bytes = 0;

  keep(line: Uint8Array): void {
    const text = new TextDecoder().decode(line);
    this.#lines.push({ text, bytes: line.length });
    this.#bytes += line.length;
    while (this.#lines.length > TAIL_LINES || this.#bytes > TAIL_BYTES) {
      const dropped = this.#lines.shift();
      this.#bytes -= dropped?.bytes ?? 0;
    }
  }

  lines(): string[] {
    return this.#lines.map(entry => entry.text);
  }
}

/** One stream being read into the tail, and the way to stop it. */
interface Reading {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

function collect(stream: ReadableStream<Uint8Array>, tail: Tail): Reading {
  const reader = stream.getReader();
  const line = new Uint8Array(LINE_BYTES);
  let length = 0;
  const done = (async () => {
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== NEWLINE) continue;
        append(value.subarray(start, index));
        tail.keep(line.slice(0, length));
        length = 0;
        start = index + 1;
      }
      append(value.subarray(start));
    }
    if (length > 0) tail.keep(line.slice(0, length));
  })().catch(() => undefined);
  /** Bytes past the line limit are dropped, so a newline-free stream holds one fixed buffer and no more. */
  function append(bytes: Uint8Array): void {
    const room = LINE_BYTES - length;
    if (room <= 0 || bytes.length === 0) return;
    const taken = bytes.subarray(0, room);
    line.set(taken, length);
    length += taken.length;
  }
  return { done, stop: () => void reader.cancel().catch(() => undefined) };
}

function after<T>(clock: Clock, delay: number, value: T): { readonly done: Promise<T>; readonly cancel: () => void } {
  let cancel: () => void = () => undefined;
  const done = new Promise<T>(resolve => {
    cancel = clock.after(milliseconds(delay), () => resolve(value));
  });
  return { done, cancel };
}

/** Wait for `work`, but no longer than `delay`. */
async function within(clock: Clock, delay: number, work: Promise<unknown>): Promise<void> {
  const limit = after(clock, delay, undefined);
  await Promise.race([work, limit.done]);
  limit.cancel();
}

export function packageRunner(spawn: () => SpawnPort, clock: Clock): PackageInstallPort {
  return async run => {
    let child: ChildHandle;
    try {
      // Plain values only: the environment the service built (the manager's own directory first on PATH).
      const env = Object.fromEntries(
        Object.entries(run.environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
      child = spawn().start(run.executable, run.args, { env, stdin: '', ownGroup: true });
    } catch (error) {
      return { kind: 'not-started', reason: error instanceof Error ? error.message : String(error) };
    }
    const tail = new Tail();
    const readings = [collect(child.stdout, tail), collect(child.stderr, tail)];
    const exited = child.exited.catch(() => null);
    const deadline = after(clock, run.timeoutMs, 'timed-out' as const);
    const ended = await Promise.race([exited, deadline.done]);
    deadline.cancel();
    // Whatever ended the run, nothing the manager started may keep going: the whole group, then the wait for it.
    child.kill('SIGKILL');
    const code = ended === 'timed-out' ? 'timed-out' : ended;
    if (ended === 'timed-out') await within(clock, EXIT_GRACE_MS, exited);
    await within(clock, DRAIN_GRACE_MS, Promise.all(readings.map(reading => reading.done)));
    for (const reading of readings) reading.stop();
    const lines = tail.lines();
    return code === 'timed-out'
      ? { kind: 'timed-out', tail: lines }
      : { kind: 'exited', code: code ?? -1, tail: lines };
  };
}
