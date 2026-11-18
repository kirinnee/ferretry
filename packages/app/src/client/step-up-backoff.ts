import type { TransportAnswer } from './transport.ts';

/**
 * A READ NOBODY PRESSED, REFUSED FOR A STEP-UP, IS NOT ASKED AGAIN AT ONCE (A555 r7).
 *
 * A background read (a panel mounting, a poll, a re-render re-running an effect) that the daemon refuses with
 * `403 grant_step_up_required` raises no prompt: the person did not start it. Before, nothing stopped the page asking
 * again straight away, and one panel sent the same refused read ~140 times a minute over the relay, each refusal a
 * re-render and each re-render the next read. So the client — the one place every plugin's read passes — keeps the
 * refusal per request and answers that same read with it, without sending, for a wait that doubles from 2 s to a
 * minute while the refusals continue. Any other answer to it forgets it; a confirmed passkey forgets them all.
 *
 * It never widens anything: what it answers is the daemon's own refusal, and it holds no value but that refusal.
 */
export class StepUpBackoff {
  readonly #held = new Map<
    string,
    { readonly until: number; readonly wait: number; readonly answer: TransportAnswer }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly first = 2_000,
    private readonly most = 60_000,
  ) {}

  /** The refusal this read is still answered with, or `undefined` once its wait is over (or it holds none). */
  held(key: string): TransportAnswer | undefined {
    const entry = this.#held.get(key);
    return entry !== undefined && this.now() < entry.until ? entry.answer : undefined;
  }

  /** This read was refused for a step-up again: hold the refusal, twice as long as the last time. */
  refused(key: string, answer: TransportAnswer): void {
    const last = this.#held.get(key)?.wait;
    const wait = last === undefined ? this.first : Math.min(last * 2, this.most);
    this.#held.set(key, { until: this.now() + wait, wait, answer });
  }

  /** This read was answered otherwise: it is asked as usual again. */
  forget(key: string): void {
    this.#held.delete(key);
  }

  /** A passkey was confirmed on this machine: every held read may be asked again. */
  clear(): void {
    this.#held.clear();
  }
}

/** One request as the backoff keys it: the method, the filled path and the query, never a header or a body. */
export const backoffKey = (request: {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
}): string => `${request.method.toUpperCase()} ${request.path}?${new URLSearchParams(request.query ?? {}).toString()}`;
