const HOSTED_RELAY_DAY_MILLISECONDS = 86_400_000;
const HOSTED_RELAY_MINUTE_MILLISECONDS = 60_000;
export const HOSTED_RELAY_BANDWIDTH_REASONS = {
  daemon: {
    minute: 'hosted relay per-daemon minute bandwidth ceiling is reached',
    day: 'hosted relay per-daemon daily bandwidth ceiling is reached',
  },
  global: {
    minute: 'hosted relay global minute bandwidth ceiling is reached',
    day: 'hosted relay global daily bandwidth ceiling is reached',
  },
} as const;
export const HOSTED_RELAY_RESETS_MARK = '; resets ' as const;

/**
 * A byte-ceiling refusal reason with its reset instant. The longest is 91 characters, inside the
 * 123-byte WebSocket close reason the same text is also sent as.
 */
export function hostedBandwidthReason(reason: string, retryAt: number): string {
  return `${reason}${HOSTED_RELAY_RESETS_MARK}${new Date(retryAt).toISOString()}`;
}

/** What a `4433` reason says: whose allowance ran out, and over which window. */
export interface HostedBandwidthRefusalReason {
  readonly scope: 'daemon' | 'global';
  readonly window: 'minute' | 'day';
  /** The reset instant the relay carried, or `null` when it carried none or one that does not parse. */
  readonly resetsAt: number | null;
}

/** A refusal with a reset instant that is always known. */
export interface HostedBandwidthRefusal extends HostedBandwidthRefusalReason {
  readonly resetsAt: number;
}

/**
 * Read a `4433` reason without a clock, or `null` for one that is not a byte-ceiling refusal. A relay
 * deployed before the reset was carried says only the bare sentence, so `resetsAt` may be `null`.
 */
export function readHostedBandwidthRefusal(reason: string): HostedBandwidthRefusalReason | null {
  for (const scope of ['daemon', 'global'] as const) {
    for (const window of ['minute', 'day'] as const) {
      const sentence = HOSTED_RELAY_BANDWIDTH_REASONS[scope][window];
      if (!reason.startsWith(sentence)) continue;
      const rest = reason.slice(sentence.length);
      const carried = rest.startsWith(HOSTED_RELAY_RESETS_MARK)
        ? Date.parse(rest.slice(HOSTED_RELAY_RESETS_MARK.length))
        : Number.NaN;
      return { scope, window, resetsAt: Number.isFinite(carried) ? carried : null };
    }
  }
  return null;
}

/**
 * Read a `4433` reason against `now`, so the reset is always an instant to wait for.
 *
 * The windows are the UTC minute and the UTC day on every relay version, so a missing reset is derived
 * — the next UTC midnight for a day, a minute from now for a minute. A carried instant already in the
 * past is derived the same way rather than trusted.
 */
export function parseHostedBandwidthRefusal(reason: string, now: number): HostedBandwidthRefusal | null {
  const read = readHostedBandwidthRefusal(reason);
  if (read === null) return null;
  if (read.resetsAt !== null && read.resetsAt > now) return { ...read, resetsAt: read.resetsAt };
  const resetsAt =
    read.window === 'day'
      ? Math.floor(now / HOSTED_RELAY_DAY_MILLISECONDS) * HOSTED_RELAY_DAY_MILLISECONDS + HOSTED_RELAY_DAY_MILLISECONDS
      : now + HOSTED_RELAY_MINUTE_MILLISECONDS;
  return { ...read, resetsAt };
}

/** The refusal a per-daemon connection ceiling produces, named once so callers can recognise it. */
