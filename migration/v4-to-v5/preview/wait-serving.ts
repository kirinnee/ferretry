/**
 * `preview.sh start` waits here for the preview daemon to SERVE before it proves anything through it.
 *
 * `fy5 daemon start` stops waiting after its own fixed 30 s and then says the daemon is "not answering", while a
 * daemon on the owner's home can still be starting (the 5.0 preview took 38 s from process start to "the daemon is
 * serving" on 2026-11-10). So the wait is for the daemon's own answer, never a sleep: `GET /healthz` on the preview
 * port answers `503` while the plugins start and `200` once the daemon serves (the moment it logs "the daemon is
 * serving"). The deadline is stated in every sentence, with the last answer seen, so a miss says what it waited for.
 *
 * An answer on the preview port proves nothing by itself: anything else on loopback can own that port. So a `200` is
 * trusted only while a process still holds the preview home's own `run/daemon.lock` (the proof `stop` uses), and
 * `previewBooting` is the same question asked before the wait, after a `daemon start` that failed.
 */
import { lockFileOf, pidsHolding } from './stop.ts';

/** How long `start` waits for the daemon to serve. The owner's home took 38 s on 2026-11-10; a grown one may take more. */
export const SERVING_DEADLINE_MS = 180_000;
/** How often the health route is asked. */
const LOOK_MS = 500;
/** How long one ask may take before it counts as no answer. */
const ASK_MS = 2_000;

export interface WaitServingInput {
  readonly port: number;
  /** `fetch`, or a stand-in: asked for `http://127.0.0.1:<port>/healthz` only. */
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<{ readonly status: number }>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  /** The pids that hold the preview home's own daemon lock (`pidsHolding(lockFileOf(target))`). */
  readonly holders: () => Promise<readonly number[]>;
  readonly deadlineMs?: number;
}

/** The ports `previewBooting` reads: the preview home and who holds its lock. */
export interface BootingInput {
  readonly target: string;
  readonly holders?: (lockFile: string) => Promise<readonly number[]>;
}

/**
 * Whether the preview's OWN daemon is booting: some process holds `<target>/run/daemon.lock`. After a failed
 * `daemon start` this is the only reason to go on waiting; otherwise the failure is the answer.
 */
export async function previewBooting(input: BootingInput): Promise<boolean> {
  return (await (input.holders ?? pidsHolding)(lockFileOf(input.target))).length > 0;
}

export interface WaitServing {
  readonly ok: boolean;
  readonly sentence: string;
}

/** What the last ask saw, in words. */
type Seen = 'no answer' | 'starting (503)' | `answered ${number}`;

const describe = (status: number): Seen => (status === 503 ? 'starting (503)' : `answered ${status}`);

/** Asks `GET /healthz` until it answers `200` or the deadline passes. Never throws: a miss is a sentence. */
export async function waitServing(input: WaitServingInput): Promise<WaitServing> {
  const deadlineMs = input.deadlineMs ?? SERVING_DEADLINE_MS;
  const url = `http://127.0.0.1:${String(input.port)}/healthz`;
  const started = input.nowMs();
  let seen: Seen = 'no answer';
  for (;;) {
    try {
      const response = await input.fetch(url, { signal: AbortSignal.timeout(ASK_MS) });
      if (response.status === 200) {
        // Something answered. It is the preview daemon only while the preview's own lock is still held.
        if ((await input.holders()).length === 0)
          return {
            ok: false,
            sentence: `${url} answered 200, but no process holds the preview daemon's lock (run/daemon.lock): the answer is not the preview daemon's (another process owns port ${String(input.port)}, or the daemon died), so it is not trusted.`,
          };
        const seconds = Math.round((input.nowMs() - started) / 100) / 10;
        return { ok: true, sentence: `the preview daemon serves (GET ${url} answered 200 after ${String(seconds)} s)` };
      }
      seen = describe(response.status);
    } catch {
      seen = 'no answer';
    }
    if (input.nowMs() - started >= deadlineMs) break;
    await input.sleep(LOOK_MS);
  }
  return {
    ok: false,
    sentence: `the preview daemon did not serve within ${String(Math.round(deadlineMs / 1000))} s: waited for GET ${url} to answer 200, and the last ask saw ${seen}. Its log is under the preview home's logs/ (fyd.log).`,
  };
}
