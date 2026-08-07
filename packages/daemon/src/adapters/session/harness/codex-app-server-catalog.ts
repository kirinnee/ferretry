import { isAbsolute } from 'node:path';
import type { RuntimeModelChoice } from '@ferretry/protocol';
import { CodexModelCatalogError, CodexModelListExchange } from '../../../lib/index.ts';

/**
 * Reading one Codex account's advertised model catalog from that account's own app-server.
 *
 * The IO half of `lib/session/harness/codex-app-server.ts`: it spawns the child, splits its output
 * into lines, enforces a deadline and drains its error stream. Every judgement about what a reply
 * MEANS belongs to the exchange, which is why this file contains no knowledge of Codex's protocol
 * beyond the argv that starts it.
 *
 * THE ACCOUNT'S OWN EXECUTABLE, IN THE SESSION'S OWN DIRECTORY. The wrapper carries the harness home,
 * the provider configuration and the credentials, and the working directory carries the project
 * configuration — all four decide which models Codex will offer. A probe run anywhere else answers a
 * question nobody asked, and would name rows the session's picker does not render.
 *
 * BOTH PATHS MUST BE ABSOLUTE, refused rather than resolved. A relative executable is looked up on
 * `PATH`, which for a daemon started by a service manager is whatever that manager happened to
 * export — so a bare name can land on a different Codex than the one the session is running.
 */

/** Only what a harness needs to be itself; nothing else about this host reaches the child. */
const INHERITED: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'];

/** Only the two things reaping needs. Naming it keeps the escalation readable, and independent of
 *  which pipes this particular spawn happened to open. */
interface ProbeChild {
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface CodexAppServerOptions {
  /** How long the whole exchange gets before the child is killed. */
  readonly timeoutMs?: number;
  /** How this daemon introduces itself in the handshake. */
  readonly clientName: string;
  readonly clientVersion: string;
  /** The environment to draw the inherited names from. Injected so a test never reads the real one. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How long a signalled child gets to die before the next signal, and how long its own diagnostics
 * get to arrive once the exchange is already over.
 *
 * Every wait on this path is bounded by it, because the child this class talks to is exactly the
 * child that might not cooperate: a probe that escalated `SIGTERM` to `SIGKILL` by awaiting
 * `child.exited` would hang on the process it is trying to kill.
 */
const REAP_GRACE_MS = 250;

/** A deadline that fired. A resolved sentinel rather than a rejection, so a race the read wins
 *  cannot leave a rejected promise nobody handled. */
const EXPIRED = Symbol('codex-catalog-deadline');

/** What one exchange ended as. Assembling the message from this, rather than throwing from inside
 *  the loop, is what keeps "timed out" and "ended early" two distinct sentences with one author. */
type ConverseOutcome =
  | { readonly kind: 'complete'; readonly choices: readonly RuntimeModelChoice[] }
  /** The child's stdout reached EOF before the catalog was complete. */
  | { readonly kind: 'ended' }
  | { readonly kind: 'expired' };

/** Sub-second deadlines are real — the tests use them — and `Math.round(ms / 1000)` renders every
 *  one of them as `0s`, which reads as "no deadline at all". */
const formatDeadline = (milliseconds: number): string =>
  milliseconds < 1_000 ? `${milliseconds}ms` : `${Math.round(milliseconds / 1_000)}s`;

/** The allowlisted names, as the child will see them. */
function childEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export class CodexAppServerCatalog {
  constructor(private readonly options: CodexAppServerOptions) {}

  /** The models this account advertises right now, in the order its picker will render them. */
  async models(binary: string, cwd: string): Promise<readonly RuntimeModelChoice[]> {
    if (!isAbsolute(binary))
      throw new CodexModelCatalogError('the Codex model catalog probe needs an absolute wrapper path');
    if (!isAbsolute(cwd))
      throw new CodexModelCatalogError('the Codex model catalog probe needs an absolute session directory');

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = Bun.spawn([binary, 'app-server', '--stdio'], {
      cwd,
      env: childEnvironment(this.options.environment ?? Bun.env),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // ACCUMULATED AS IT ARRIVES, rather than awaited as one `Response.text()` that only settles at
    // EOF. Two reasons, and the second is why the first is not enough: a child still holding its
    // stderr open never reaches EOF, and killing one makes the stream error — so a single `.text()`
    // yields nothing in exactly the two cases whose diagnostics are worth having. Reading into a
    // buffer keeps whatever the child managed to say. The rejection is handled here because every
    // successful probe returns without ever looking, and a floating one is an unhandled rejection in
    // a long-lived daemon raised by the path that went right.
    const diagnostics = { text: '' };
    const stderr = this.#drain(child.stderr, diagnostics);
    const exchange = new CodexModelListExchange();
    const write = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof EXPIRED>(resolve => {
      timer = setTimeout(() => resolve(EXPIRED), timeoutMs);
    });

    // THE OUTER `finally` IS THE ONE THAT RELEASES STDERR, and it is outermost so that every exit —
    // a complete catalog, either ending, or a throw from inside the exchange — passes through it. A
    // descendant that inherited stderr keeps that stream from ever reaching EOF, so a drain nobody
    // cancels is an immortal background read holding a descriptor for the life of the daemon. It is
    // cancelled AFTER the diagnostic window below, never before, so a late complaint still counts.
    try {
      let outcome: ConverseOutcome;
      try {
        write(exchange.start(this.options.clientName, this.options.clientVersion));
        outcome = await this.#converse(child.stdout, exchange, write, deadline);
      } finally {
        clearTimeout(timer);
        child.stdin.end();
        await this.#reap(child);
      }

      if (outcome.kind === 'complete') return outcome.choices;
      // The last line of the child's own diagnostics is the most useful thing available: the daemon
      // knows only that the exchange is over, and Codex usually says why on the way out. Both endings
      // get it, because "it timed out, and here is what it was complaining about" is strictly more
      // than "it timed out" — and reading it can no longer reintroduce a hang.
      const detail = await this.#lastDiagnostic(stderr.settled, diagnostics);
      if (outcome.kind === 'expired')
        throw new CodexModelCatalogError(
          `the Codex model catalog probe timed out after ${formatDeadline(timeoutMs)}${detail}`,
        );
      throw new CodexModelCatalogError(`the Codex model catalog probe ended before the catalog was complete${detail}`);
    } finally {
      stderr.cancel();
    }
  }

  /**
   * Feed whole lines to the exchange until it answers, the stream ends, or the deadline fires.
   *
   * THE DEADLINE RACES THE READ, NOT THE PROCESS. This loop used to be `for await (const chunk of
   * stdout)` while a timer merely called `child.kill()`, which bounds nothing on its own: a child
   * that ignores `SIGTERM`, or any descendant that inherited stdout, holds the pipe open and the
   * `read()` never returns. Measured on both shapes, the probe then never settled at all — and
   * `CodexRuntimeCatalogCache` hands that same never-settling promise to every later reader and only
   * forgets it on rejection, so one stubborn child made an account's catalog permanently unreadable
   * and wedged the per-session runtime queue behind it. Racing each read is what makes the declared
   * deadline the real one.
   */
  async #converse(
    stdout: ReadableStream<Uint8Array>,
    exchange: CodexModelListExchange,
    write: (message: unknown) => void,
    deadline: Promise<typeof EXPIRED>,
  ): Promise<ConverseOutcome> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next === EXPIRED) return { kind: 'expired' };
        if (next.done) return { kind: 'ended' };
        buffer += decoder.decode(next.value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line === '') continue;
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            throw new CodexModelCatalogError('the Codex app-server wrote a non-JSON model catalog response');
          }
          const step = exchange.receive(message);
          for (const outgoing of step.send) write(outgoing);
          if (step.choices !== undefined) return { kind: 'complete', choices: step.choices };
        }
      }
    } finally {
      // NOT AWAITED, deliberately. Releasing the descriptor matters — a rejected probe is re-tried,
      // so leaking one per attempt is a real leak — but cancelling a pipe a stubborn descendant is
      // still holding is exactly the wait this method exists to stop taking.
      void reader.cancel().catch(() => undefined);
    }
  }

  /**
   * Signal, escalate, and never wait longer than the grace for either.
   *
   * `await child.exited` was the second unbounded wait on this path: it is the process being killed
   * that decides when it resolves. A descendant that inherited stdout survives even `SIGKILL` of its
   * parent — this daemon no longer *waits* on it, which is the defect being fixed, but it is orphaned
   * rather than reaped, because killing the whole process group is not reachable through
   * `Bun.spawn` today.
   */
  async #reap(child: ProbeChild): Promise<void> {
    child.kill();
    if (await this.#exitedWithinGrace(child)) return;
    child.kill('SIGKILL');
    await this.#exitedWithinGrace(child);
  }

  async #exitedWithinGrace(child: ProbeChild): Promise<boolean> {
    return await Promise.race([
      child.exited.then(
        () => true,
        () => true,
      ),
      Bun.sleep(REAP_GRACE_MS).then(() => false),
    ]);
  }

  /**
   * Collect stderr into `sink` for as long as the child keeps talking, and hand back the off switch.
   *
   * The cancel is the point. `for await (… of stderr)` cannot be stopped from outside, and stderr is
   * the one stream this class must assume never closes: a descendant that inherited it holds it open
   * after the child is gone. Owning the reader means the caller can release the descriptor the moment
   * the diagnostic window shuts.
   */
  #drain(
    stderr: ReadableStream<Uint8Array>,
    sink: { text: string },
  ): { readonly settled: Promise<void>; readonly cancel: () => void } {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    const settled = (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          sink.text += decoder.decode(next.value, { stream: true });
        }
      } catch {
        // A killed or cancelled stream errors mid-read. Whatever landed in `sink` still counts.
      }
    })();
    return {
      settled,
      // Not awaited: cancelling a pipe a live descendant still holds is exactly the wait every other
      // bound on this path exists to avoid taking.
      cancel: () => {
        void reader.cancel().catch(() => undefined);
      },
    };
  }

  /**
   * The child's last complaint, or nothing.
   *
   * Waits only the grace for the drain to finish, then reads the buffer regardless — so a child that
   * is still holding stderr open contributes what it has already written instead of nothing, and
   * cannot make the probe outlast its own deadline.
   */
  async #lastDiagnostic(settled: Promise<void>, sink: { text: string }): Promise<string> {
    await Promise.race([settled, Bun.sleep(REAP_GRACE_MS)]);
    const line = sink.text
      .trim()
      .split('\n')
      .filter(candidate => candidate.trim() !== '')
      .at(-1);
    return line === undefined ? '' : `: ${line}`;
  }
}
