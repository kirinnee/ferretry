/**
 * Safety policy for reclaiming an expired session's non-daemon files.
 *
 * The session journal is authoritative, so this module deliberately defines
 * daemon-owned material as a whitelist.  A name which merely looks temporary
 * must never be reclaimed by inference.
 */

export const DAEMON_OWNED_SCRATCH_ENTRIES: ReadonlySet<string> = new Set([
  'attachments',
  'channel',
  'checks',
  'chat.jsonl',
  'config.json',
  'events.jsonl',
  'kill.json',
  'last-snapshot.txt',
  'launch.sh',
  'liveness.yaml',
  'logs',
  'markers',
  'raw',
  'snapshots',
  'state.json',
  'summary.md',
  'system.md',
  'turns',
]);

/** An in-flight atomic write of one of the daemon's documents is also owned. */
export function isDaemonOwnedScratchEntry(name: string): boolean {
  if (DAEMON_OWNED_SCRATCH_ENTRIES.has(name)) return true;
  const base = name.split('.tmp.')[0];
  return name.includes('.tmp.') && base !== undefined && DAEMON_OWNED_SCRATCH_ENTRIES.has(base);
}

export const TERMINAL_SCRATCH_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'stalled']);

export interface ScratchEligibilityInput {
  readonly status?: string;
  readonly finishedAt?: string;
  readonly newestMtimeMs?: number;
  readonly nowMs: number;
  readonly ttlMs: number;
  readonly hasMonitor: boolean;
  readonly hasLivePane: boolean;
  readonly launching: boolean;
  readonly wardenTarget: boolean;
}

export interface ScratchEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
}

/**
 * The complete reclaim decision, kept pure so a sweep can explain every refusal
 * before it touches a session directory.
 */
export function scratchEligibility(input: ScratchEligibilityInput): ScratchEligibility {
  if (input.status === undefined || !TERMINAL_SCRATCH_STATUSES.has(input.status))
    return { eligible: false, reason: 'not terminal' };
  if (input.hasMonitor) return { eligible: false, reason: 'a monitor is still attached' };
  if (input.hasLivePane) return { eligible: false, reason: 'the tmux pane is still alive' };
  if (input.launching) return { eligible: false, reason: 'a launch claim is in flight' };
  if (input.wardenTarget) return { eligible: false, reason: 'a live warden is assigned to it' };

  const finishedMs = input.finishedAt === undefined ? Number.NaN : Date.parse(input.finishedAt);
  const settledAt = Number.isFinite(finishedMs) ? finishedMs : input.newestMtimeMs;
  if (settledAt === undefined) return { eligible: false, reason: 'no finishedAt and no file mtime to age from' };
  const age = input.nowMs - settledAt;
  if (age < input.ttlMs)
    return { eligible: false, reason: `terminal for ${Math.round(age / 3_600_000)}h, under the TTL` };
  if (input.newestMtimeMs !== undefined && input.nowMs - input.newestMtimeMs < input.ttlMs)
    return { eligible: false, reason: 'a file under the session directory changed inside the TTL' };
  return { eligible: true };
}
