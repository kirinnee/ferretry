/**
 * WHAT CROSSES BETWEEN THE DAEMON AND ITS HOUSEKEEPING WORKER (docs/design/housekeeping-worker.md §2.3).
 *
 * The worker reads credential stores, makes the free usage reads, reads passive usage files and walks
 * Codex homes for an undiscovered session's rollout. Main keeps every lock, head and write, and asks the
 * worker by job. Both directions are closed
 * unions, and each side switches over them exhaustively.
 *
 * NOTHING HERE CAN CARRY CREDENTIAL MATERIAL. A job names a store — paths, a keychain service and
 * account NAME — and an answer is facts: presence flags, expiries, a truncated digest, a usage reading.
 * No type in this file has a field a blob or a token could travel in, and a type test holds that. A
 * failure is a member of {@link HousekeepingFailure}, never a caught error's message, because a JSON
 * parser's message can quote the very bytes it failed on.
 *
 * Type-only imports: the protocol costs the worker nothing at run time.
 */
import type {
  ActiveUsageRead,
  LocalCredentialFacts,
  PassiveUsageRecord,
  StoredCredentialResolution,
} from '@ferretry/fleet';
import type { CodexRolloutCandidate } from '../session/transcript/codex-rollout.ts';

/** What every new worker thread is told before its first job: where things are on this host. */
export interface HousekeepingSettings {
  readonly type: 'settings';
  /** The host platform, `linux` or `darwin` as Node names it: whether a Claude login is in the keychain. */
  readonly platform: string;
  /** The account a Claude keychain item is filed under (`claudeKeychainAccount`). A name, not a secret. */
  readonly keychainAccount: string;
  /** The Claude home with no `CLAUDE_CONFIG_DIR`, whose keychain item carries no suffix. */
  readonly defaultClaudeHome: string;
  /** `<home>/fleet`, where each credential's `usage.json` is. */
  readonly fleetRoot: string;
  /** Where the free usage reads go when a loopback test server stands in (`FY_USAGE_PROBE_ORIGIN`). */
  readonly probeUrls?: { readonly anthropic: string; readonly codex: string };
  /** How long a free usage read may take; the probes' own 20 s when absent. */
  readonly usageTimeoutMs?: number;
}

/** One piece of work, by kind. Every argument is a path, an id or a store's name. */
export type HousekeepingJob =
  /** The store's facts: one read, reduced to facts in the worker. */
  | { readonly kind: 'credential.local'; readonly resolution: StoredCredentialResolution }
  /** The free usage read, with a token from ONE read of the store, dropped in the same call. */
  | { readonly kind: 'credential.active'; readonly resolution: StoredCredentialResolution }
  /** A Claude credential's statusLine reading, `<fleet>/credentials/<id>/usage.json`. */
  | { readonly kind: 'usage.passive.claude'; readonly credential: string }
  /** The newest rate-limit reading across the rollouts main attributed to one Codex credential. */
  | { readonly kind: 'usage.passive.codex'; readonly files: readonly string[] }
  /**
   * The rollouts under a Codex home that could be one session's: every one outside `skip` (the session's
   * baseline), each marked with whether it carries the session's correlation token.
   */
  | {
      readonly kind: 'codex.discover';
      readonly home: string;
      readonly correlationToken: string;
      readonly skip: readonly string[];
    };

export type HousekeepingJobKind = HousekeepingJob['kind'];

/** What each kind of job answers. `null` is "no reading", because `undefined` does not survive a clone. */
export interface HousekeepingJobValues {
  readonly 'credential.local': LocalCredentialFacts;
  readonly 'credential.active': ActiveUsageRead;
  readonly 'usage.passive.claude': PassiveUsageRecord | null;
  readonly 'usage.passive.codex': PassiveUsageRecord | null;
  readonly 'codex.discover': CodexDiscovery;
}

/**
 * One walk of a Codex home. The CHOICE is main's: it holds the claims and writes the binding, so the
 * worker only says what each candidate file is.
 */
export interface CodexDiscovery {
  readonly candidates: readonly CodexRolloutCandidate[];
  /** How many times this walk saw the home's listing change: a new or removed rollout or directory. */
  readonly changed: number;
  /**
   * The directories a new rollout would appear in — `sessions`, its newest year and month, and its two
   * newest day directories — for main to watch, so a quiet home needs no walk at all.
   */
  readonly frontier: readonly string[];
}

export type HousekeepingValue = HousekeepingJobValues[HousekeepingJobKind];

/**
 * Why a job has no answer, as a closed set. `internal`: the job threw, and what it threw is not said.
 * `unsettled`: a job arrived before the thread was told its settings.
 */
export type HousekeepingFailure = 'internal' | 'unsettled';

/** Main → worker. */
export type HousekeepingRequest =
  | HousekeepingSettings
  /** `fyd --check`'s probe (`probeBundledWorker`): the worker answers `{ probe: true }`. */
  | { readonly probe: true }
  | { readonly type: 'job'; readonly id: number; readonly job: HousekeepingJob };

/** One child process a job started: its command line (a program, a keychain service name) and its wall. */
export interface HousekeepingChild {
  readonly argv: readonly string[];
  readonly wallMs: number;
}

/**
 * What one job cost inside the worker, which main's instruments cannot see: the worker's `Bun.spawn`
 * is not the one the daemon counts, and its file reads go through no port of main's.
 */
export interface HousekeepingMetrics {
  readonly type: 'metrics';
  readonly id: number;
  readonly kind: HousekeepingJobKind;
  readonly wallMs: number;
  readonly children: readonly HousekeepingChild[];
  /** Files the job opened. */
  readonly fileReads: number;
  /** HTTP requests the job made. */
  readonly fetches: number;
  /** The worker's own JavaScript heap after the job, in bytes. */
  readonly heapBytes: number;
}

/** Worker → main. */
export type HousekeepingResponse =
  | { readonly type: 'result'; readonly id: number; readonly ok: true; readonly value: HousekeepingValue }
  | { readonly type: 'result'; readonly id: number; readonly ok: false; readonly failure: HousekeepingFailure }
  | HousekeepingMetrics
  | { readonly probe: true };
