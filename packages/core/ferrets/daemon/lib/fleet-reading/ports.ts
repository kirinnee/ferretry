/**
 * What the fleet reading needs from the subsystems around it, declared here as narrow ports so the reading owns its
 * own contract: the usage and credential facts it reads (today's `@ferretry/fleet`), the file-event hub it listens
 * on and the housekeeping jobs it reads through. Each type names only the fields the reading touches; the real
 * owners' values satisfy them structurally.
 */

/** One usage window as a passive reading states it; absent is unknown, never 0%. */
export interface UsageWindow {
  readonly usedPercent?: number;
}

/** One passive reading of one credential's two windows (today's `PassiveUsageRecord`). */
export interface PassiveUsageRecord {
  readonly source: 'claude-statusline' | 'codex-rollout';
  /** When the reading was taken, epoch milliseconds. */
  readonly at: number;
  readonly fiveHour?: UsageWindow;
  readonly weekly?: UsageWindow;
}

/** A credential whose login is on disk: where the reading watches its store. */
export type StoredCredentialResolution =
  | { readonly harness: 'claude'; readonly credentialFile: string }
  | { readonly harness: 'codex'; readonly canonicalFile: string };

/** One credential, as the reading is asked about it. */
export interface CredentialSubject {
  readonly id: string;
  readonly resolution: { readonly harness: 'claude' | 'codex' };
}

/** One ferret this daemon started, as usage attribution reads it: which runtime ran it and where it wrote. */
export interface CredentialSessionRecord {
  /** The runtime the ferret was started on. */
  readonly agent: string;
  readonly transcript?: { readonly home: string; readonly file?: string };
}

/** A watch on one path (today's `FileSubscription` of the file-event hub). */
export interface FileSubscription {
  /** Whether a change to the path is reported by an event right now; when not, a reader checks for itself. */
  live(): boolean;
  /** Stop listening. Idempotent. */
  close(): void;
}

/** The two housekeeping jobs the reading runs (today's `usage.passive.*`). */
export type FleetReadingJob =
  | { readonly kind: 'usage.passive.claude'; readonly credential: string }
  | { readonly kind: 'usage.passive.codex'; readonly files: readonly string[] };

/** Where those jobs run: the housekeeping worker, or the main thread; a caller cannot tell which answered. */
export interface FleetReadingJobs {
  run(job: FleetReadingJob): Promise<PassiveUsageRecord | null>;
}

const hasSignal = (reading: PassiveUsageRecord | undefined): reading is PassiveUsageRecord =>
  reading !== undefined && (reading.fiveHour?.usedPercent !== undefined || reading.weekly?.usedPercent !== undefined);

/**
 * When a credential is due its active free read (today's `activeUsageReadDueAt`): a passive reading that measured
 * something holds it off until it is one interval old; with none, the last time a pass observed the credential does.
 * Never observed and no passive reading is due now (`-Infinity`).
 */
export function activeUsageReadDueAt(
  passive: PassiveUsageRecord | undefined,
  observedAt: number | undefined,
  intervalMs: number,
): number {
  const measured = hasSignal(passive) ? passive.at : undefined;
  return Math.max(measured ?? Number.NEGATIVE_INFINITY, observedAt ?? Number.NEGATIVE_INFINITY) + intervalMs;
}

/**
 * The transcripts of the ferrets that ran on this credential: one started on one of its runtimes. A rollout this
 * daemon did not start has no record, so it is never attributed: the shared pool mixes credentials.
 */
export function attributedTranscripts(
  entry: { readonly usedBy: readonly string[] },
  sessions: readonly CredentialSessionRecord[],
): readonly string[] {
  const files = new Set<string>();
  for (const session of sessions) {
    const file = session.transcript?.file;
    if (file === undefined) continue;
    if (entry.usedBy.includes(session.agent)) files.add(file);
  }
  return [...files].sort();
}
