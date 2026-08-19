/**
 * Launching one harness login with PIPED stdio, and delivering its output as lines.
 *
 * This adapter is the whole of the property change the feature makes. `fy fleet login` inherits all
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
 * `Bun.spawn` is given the command as an argv ARRAY and no shell. The first element is the absolute
 * wrapper path the manifest publishes; nothing here resolves a name, and there is no `PATH` fallback —
 * see the service for why a daemon started by a service manager must not have one.
 */
import type {
  HarnessLoginChild,
  HarnessLoginChildSpec,
  HarnessLoginSpawn,
  HarnessLoginTimer,
} from '../../lib/fleet-login/ports.ts';

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

/** Launch one harness login child. */
export const spawnHarnessLoginChild: HarnessLoginSpawn = (spec: HarnessLoginChildSpec): HarnessLoginChild => {
  const child = Bun.spawn({
    cmd: [...spec.command],
    env: spec.environment,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Both pumps are started now and never awaited by the caller: a stream nobody drains fills its pipe
  // and the child blocks writing to it, which would look exactly like a harness that printed nothing.
  // A pump that throws is a stream that ended abruptly, which the exit code already reports.
  void pump(child.stdout as ReadableStream<Uint8Array> | undefined, spec.onLine).catch(() => undefined);
  void pump(child.stderr as ReadableStream<Uint8Array> | undefined, spec.onLine).catch(() => undefined);

  return {
    write: async value => {
      try {
        const writer = child.stdin;
        if (writer === undefined || writer === null) return false;
        // ASKED OF THE CHILD, not inferred from the write. A write into the stdin of a child that has
        // already exited is BUFFERED and reports success — measured, not assumed — so a `try`/`catch`
        // around it detects nothing and would let the caller answer "accepted" about a value nothing
        // read. The exit state is the only thing here that knows.
        if (child.exitCode !== null || child.signalCode !== null) return false;
        writer.write(value);
        await writer.flush();
        return true;
      } catch {
        // A child that goes away DURING the write. The race is real and unavoidable, and it is exactly
        // why the wire has an `unconfirmed` outcome: nobody can say whether the value arrived. Raising
        // here would be reported as a failure instead, which invites a retry that cannot help.
        return false;
      }
    },
    kill: () => {
      // Idempotent by contract, and `kill` on an exited child is not an error worth propagating: a cancel
      // that raced the child's own exit has still achieved what it was asked to.
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
    exited: child.exited,
  };
};

/**
 * A one-shot timer that cannot hold this daemon open.
 *
 * `unref` is the whole reason this is an adapter rather than a `setTimeout` at the call site: a pending
 * login window would otherwise keep the event loop alive for its full ten minutes, so a daemon asked to
 * stop would appear to hang on a login nobody was waiting for.
 */
export const harnessLoginTimer: HarnessLoginTimer = {
  after: (milliseconds, run) => {
    const handle = setTimeout(run, milliseconds);
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};
