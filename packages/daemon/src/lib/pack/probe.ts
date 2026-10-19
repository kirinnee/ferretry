/**
 * THE START PROBE (docs/pack-mode.md): before `fy new` starts a sub-ferret it asks the chosen runtime
 * and model to "reply OK", with a bounded timeout and the lowest effort the CLI lets it set. A runtime
 * that does not answer OK in time is refused `probe_failed` and nothing is started — in both decision
 * modes, because a ferret that cannot answer one line will not do the work either.
 *
 * A probe spends a token or two, and only when a ferret asked for a start. Its answer is kept for
 * `cacheSeconds` per runtime and model, and probes already running are shared, so twenty sub-ferrets
 * started at once probe once.
 */

/** What one probe asks. */
export interface PackProbeRequest {
  /** The runtime's command (its wrapper), as a start would launch it. */
  readonly wrapper: string;
  readonly harness: 'claude' | 'codex';
  /** Absent: the runtime's own default model. */
  readonly model?: string | undefined;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type PackProbeOutcome =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly ms: number; readonly reason: string };

/** Runs one probe. The adapter starts the runtime's CLI in its one-shot mode. */
export interface PackProbePort {
  probe(request: PackProbeRequest): Promise<PackProbeOutcome>;
}

/** What the cache answers: the outcome, and whether it was this call that probed. */
export interface CachedProbe {
  readonly outcome: PackProbeOutcome;
  readonly cached: boolean;
}

/** The exact words a probe asks for, and how its answer is read. */
export const PROBE_PROMPT = 'Reply with exactly: OK';

/** Whether a CLI's output is the answer asked for: an OK on its own line, case and punctuation aside. */
export function probeAnswered(output: string): boolean {
  return output.split(/\r?\n/u).some(line => /^\W*ok\W*$/iu.test(line.trim()));
}

/** Probes through `port`, keeping each answer for `ttlMs` per runtime and model. */
export class ProbeCache {
  private readonly answers = new Map<string, { readonly at: number; readonly outcome: PackProbeOutcome }>();
  private readonly running = new Map<string, Promise<PackProbeOutcome>>();

  constructor(
    private readonly port: PackProbePort,
    private readonly nowMs: () => number,
  ) {}

  async probe(request: PackProbeRequest, ttlMs: number): Promise<CachedProbe> {
    const key = `${request.wrapper}\u0000${request.model ?? ''}`;
    const kept = this.answers.get(key);
    if (kept !== undefined && this.nowMs() - kept.at < ttlMs) return { outcome: kept.outcome, cached: true };
    const shared = this.running.get(key);
    if (shared !== undefined) return { outcome: await shared, cached: true };
    const pending = this.port.probe(request).finally(() => this.running.delete(key));
    this.running.set(key, pending);
    const outcome = await pending;
    this.answers.set(key, { at: this.nowMs(), outcome });
    return { outcome, cached: false };
  }
}
