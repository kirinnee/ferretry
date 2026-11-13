/**
 * Launching one harness login with PIPED stdio, and delivering its output as lines.
 *
 * This adapter is the whole of the property change the feature makes. A terminal sign-in inherits all
 * three of the child's streams and reads none of them, because an approval is something a person does in
 * that terminal. A login a browser can drive has to pipe them instead, which makes this daemon a reader
 * of harness output for the first time — so the seam is deliberately narrow:
 *
 * - **Lines out, one at a time, to a callback.** Nothing accumulates. There is no buffer to inspect, no
 *   method that returns the stream, and nothing that could be journaled: whatever a flow does not
 *   recognise is simply never referred to again.
 * - **One write in.** `false` rather than a throw when the child has stopped reading, because "nobody can
 *   say whether that arrived" is a real outcome the caller reports as `unconfirmed` — and an exception
 *   here would be reported as a failure, which invites a retry that cannot help.
 * - **stderr is read on the same footing as stdout.** A CLI that prints its sign-in URL to stderr is not
 *   a CLI that failed to print one, and a reader that watched only stdout would report "this harness
 *   offered no remotable login" about a harness that offered one.
 *
 * The kernel's spawn port is given the command as an argv ARRAY and no shell. The first element is the absolute
 * wrapper path the manifest publishes; nothing here resolves a name, and there is no `PATH` fallback —
 * see the service for why a daemon started by a service manager must not have one.
 */
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type {
  HarnessLoginChild,
  HarnessLoginChildSpec,
  HarnessLoginSpawn,
  HarnessLoginTimer,
} from '../../lib/harness-login/ports.ts';

/**
 * Feed one stream's bytes to `onLine`, splitting on newlines and flushing whatever is left at the end.
 *
 * The trailing flush is not a nicety: `Paste code here if prompted > ` is a PROMPT and carries no
 * newline, so a splitter that only emitted complete lines would never deliver the last thing the child
 * said. It matters less for recognition than it looks — the URL arrives on its own line — but a reader
 * that silently drops the final partial line is a reader that behaves differently for the one harness
 * that ends its output with a prompt.
 */
async function pump(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
  if (stream === undefined) return;
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) onLine(part);
  }
  pending += decoder.decode();
  if (pending !== '') onLine(pending);
}

/**
 * Launch one harness login child through the kernel's spawn port.
 *
 * The kernel's child sees the base environment the host names plus `spec.environment`, so nothing of this daemon's own
 * session reaches a sign-in. The port has no process group: a kill reaches the child it started.
 */
export function spawnHarnessLoginChild(spawn: SpawnPort): HarnessLoginSpawn {
  return (spec: HarnessLoginChildSpec): HarnessLoginChild => {
    const [program, ...args] = spec.command as [string, ...string[]];
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(spec.environment)) if (value !== undefined) env[name] = value;
    const child = spawn.start(program, args, { env });
    let stopped = false;

    // Both pumps are started now and never awaited by the caller: a stream nobody drains fills its pipe
    // and the child blocks writing to it, which would look exactly like a harness that printed nothing.
    // A pump that throws is a stream that ended abruptly, which the exit code already reports.
    const drained = Promise.all([
      pump(child.stdout, spec.onLine).catch(() => undefined),
      pump(child.stderr, spec.onLine).catch(() => undefined),
    ]);
    const exit = child.exited.then(code => {
      stopped = true;
      return code ?? 1;
    });

    return {
      write: async value => {
        try {
          // ASKED OF THE CHILD, not inferred from the write: a write into the stdin of a child that has already
          // exited is buffered and reports success, so the exit state is the only thing here that knows.
          if (stopped) return false;
          child.write(value);
          return true;
        } catch {
          // A child that goes away DURING the write. The race is real and unavoidable, and it is exactly why the
          // wire has an `unconfirmed` outcome: nobody can say whether the value arrived.
          return false;
        }
      },
      kill: (signal = 'SIGTERM') => {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      },
      // Settled only once BOTH pipes have been read to the end. The exit can be reported before the last
      // line is: a Codex device login that says device codes are unavailable and exits at once would
      // otherwise be read as "printed nothing", and the switch to a link would never happen.
      exited: exit.then(async code => {
        await drained;
        return code;
      }),
    };
  };
}

/** A one-shot timer on the kernel's clock, so a flow nobody polls still ends and the kernel can stop it. */
export function harnessLoginTimer(clock: Pick<Clock, 'after'>): HarnessLoginTimer {
  return { after: (ms, run) => clock.after(milliseconds(ms), run) };
}
