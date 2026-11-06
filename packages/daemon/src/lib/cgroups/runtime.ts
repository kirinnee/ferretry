/**
 * The probe's answer, kept for the life of the daemon and refreshed on trouble.
 *
 * A LAUNCH THAT FAILS ASKS AGAIN. The manager may have come up since boot (a user session that started
 * late) or gone away since (a logout), so a failed scope launch re-probes, at most once per interval:
 * a host that cannot enforce must not pay a probe on every ferret start.
 */
import type { EnforcementState } from './enforcement.ts';

export type EnforcementProbe = () => Promise<EnforcementState>;

/** Re-probing after a failure is bounded to this often. */
export const REPROBE_INTERVAL_MS = 30_000;

export class EnforcementRuntime {
  private state: EnforcementState | undefined;
  private probedAt = 0;
  private inFlight: Promise<EnforcementState> | undefined;
  private launchFailure: string | undefined;

  constructor(
    private readonly probe: EnforcementProbe,
    private readonly now: () => number,
  ) {}

  /** The last answer, probing first if there is none. */
  async current(): Promise<EnforcementState> {
    return this.state ?? (await this.refresh());
  }

  /** The last answer without probing; `undefined` before the first. */
  last(): EnforcementState | undefined {
    return this.state;
  }

  /** The most recent launch that could not be limited, until a later one is. */
  lastLaunchFailure(): string | undefined {
    return this.launchFailure;
  }

  recordLaunchFailure(reason: string): void {
    this.launchFailure = reason;
  }

  recordLaunchSuccess(): void {
    this.launchFailure = undefined;
  }

  /** Asks the host again. Concurrent callers share one probe. */
  async refresh(): Promise<EnforcementState> {
    this.inFlight ??= this.probe()
      .then(state => {
        this.state = state;
        this.probedAt = this.now();
        return state;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return await this.inFlight;
  }

  /** After a launch problem: re-probe if the last probe is old enough, else keep the answer. */
  async afterFailure(): Promise<EnforcementState> {
    if (this.state !== undefined && this.now() - this.probedAt < REPROBE_INTERVAL_MS) return this.state;
    return await this.refresh();
  }
}
