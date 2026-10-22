/**
 * THE START PROBE (docs/pack-mode.md): before `fy new` starts a sub-ferret it asks the chosen runtime
 * and model to "reply OK", with a bounded timeout and the lowest effort the CLI lets it set. A runtime
 * that does not answer OK in time is refused `probe_failed` and nothing is started — in both decision
 * modes, because a ferret that cannot answer one line will not do the work either.
 *
 * It is a REAL round trip — the runtime's own wrapper, with its login's environment, asking the model
 * itself — so quota, sign-in and a missing model all fail it, not only a missing CLI. A failure's output is
 * read for which of those it was (`classifyProbeFailure`), so the refusal names it.
 *
 * A probe spends a token or two, and only when a ferret asked for a start. A PASS is kept for
 * `cacheSeconds` per runtime, model and effort, and probes already running are shared, so twenty
 * sub-ferrets started at once probe once. A failure is not kept: the next start asks again.
 */

/** What one probe asks. */
export interface PackProbeRequest {
  /** The runtime's wrapper NAME, as a start is asked for it; the probe resolves its launcher the way a start does. */
  readonly wrapper: string;
  readonly harness: 'claude' | 'codex';
  /** Absent: the runtime's own default model. */
  readonly model?: string | undefined;
  /**
   * The effort the start will launch at. A Claude probe passes it as the start does, so a flag the start
   * would carry cannot be refused only once the pane exists; a Codex probe runs `low` regardless.
   */
  readonly effort?: string | undefined;
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** What a failed probe's output says went wrong, when it says; otherwise it is only `probe_failed`. */
export type ProbeFailureCode = 'out_of_quota' | 'not_logged_in' | 'model_unavailable';

export type PackProbeOutcome =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly ms: number; readonly reason: string; readonly code?: ProbeFailureCode };

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

const FAILURE_PATTERNS: readonly (readonly [ProbeFailureCode, RegExp])[] = [
  [
    'out_of_quota',
    /usage limit|quota|rate[ -]?limit|limit reached|too many requests|\b429\b|insufficient (credit|balance|funds)|credit balance/iu,
  ],
  [
    'not_logged_in',
    /not logged in|please (log|sign) ?in|\/login|unauthori[sz]ed|\b401\b|invalid (api )?key|authentication (failed|error)|expired token/iu,
  ],
  [
    'model_unavailable',
    /model\b.{0,80}\b(not found|does not exist|not available|not supported|unsupported|invalid)|unknown model|invalid model|no such model/iu,
  ],
];

/**
 * Which known failure a probe's output reports — quota, sign-in, or a model the provider does not serve —
 * read from the CLI's own words. `undefined` when it names none of them. The output itself is never
 * repeated anywhere: only the code is kept.
 */
export function classifyProbeFailure(output: string): ProbeFailureCode | undefined {
  return FAILURE_PATTERNS.find(([, pattern]) => pattern.test(output))?.[0];
}

/** Probes through `port`, keeping each PASS for `ttlMs` per runtime, model and effort. */
export class ProbeCache {
  private readonly answers = new Map<string, { readonly at: number; readonly outcome: PackProbeOutcome }>();
  private readonly running = new Map<string, Promise<PackProbeOutcome>>();

  constructor(
    private readonly port: PackProbePort,
    private readonly nowMs: () => number,
  ) {}

  async probe(request: PackProbeRequest, ttlMs: number): Promise<CachedProbe> {
    const key = `${request.wrapper}\u0000${request.model ?? ''}\u0000${request.effort ?? ''}`;
    const kept = this.answers.get(key);
    if (kept !== undefined && this.nowMs() - kept.at < ttlMs) return { outcome: kept.outcome, cached: true };
    const shared = this.running.get(key);
    if (shared !== undefined) return { outcome: await shared, cached: true };
    const pending = this.port.probe(request).finally(() => this.running.delete(key));
    this.running.set(key, pending);
    const outcome = await pending;
    if (outcome.ok) this.answers.set(key, { at: this.nowMs(), outcome });
    else this.answers.delete(key);
    return { outcome, cached: false };
  }
}
