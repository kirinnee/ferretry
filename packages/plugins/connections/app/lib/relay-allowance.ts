/**
 * What a person reads when Ferretry's hosted relay refuses a machine for bytes (`4433`).
 *
 * The relay's own words are an operator's ("per-daemon daily bandwidth ceiling is reached"); the person holding the
 * phone needs three facts instead: what ran out, when it comes back, and that the machine is still reachable without
 * the relay. The reset is the instant the relay carried in its reason, shown in THIS device's local time.
 *
 * The reason grammar below is the reading half of the one the Worker writes (`worker/src/lib/hosted.ts`, which the
 * browser may not import): `tests/unit/app/relay-allowance.test.ts` pins the two together.
 */

/** Renders an instant as a short local clock time. A parameter so a test can pin the locale. */
type ClockTimeFormat = (epochMilliseconds: number) => string;

const localClockTime: ClockTimeFormat = epochMilliseconds =>
  new Date(epochMilliseconds).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const DIRECT_STILL_WORKS = 'Direct connections still work.';

/** The four byte-ceiling sentences the relay opens a `4433` reason with. */
const HOSTED_ALLOWANCE_REASONS = {
  daemon: {
    minute: 'hosted relay per-daemon minute bandwidth ceiling is reached',
    day: 'hosted relay per-daemon daily bandwidth ceiling is reached',
  },
  global: {
    minute: 'hosted relay global minute bandwidth ceiling is reached',
    day: 'hosted relay global daily bandwidth ceiling is reached',
  },
} as const;

/** What follows the sentence when the relay carries the reset instant (an ISO timestamp). */
const HOSTED_ALLOWANCE_RESETS_MARK = '; resets ';

interface Refusal {
  readonly scope: 'daemon' | 'global';
  readonly window: 'minute' | 'day';
  /** The reset the relay carried, or `null` when it carried none (or one that does not parse). */
  readonly resetsAt: number | null;
}

const readRefusal = (reason: string): Refusal | null => {
  for (const scope of ['daemon', 'global'] as const) {
    for (const window of ['minute', 'day'] as const) {
      const sentence = HOSTED_ALLOWANCE_REASONS[scope][window];
      if (!reason.startsWith(sentence)) continue;
      const rest = reason.slice(sentence.length);
      const carried = rest.startsWith(HOSTED_ALLOWANCE_RESETS_MARK)
        ? Date.parse(rest.slice(HOSTED_ALLOWANCE_RESETS_MARK.length))
        : Number.NaN;
      return { scope, window, resetsAt: Number.isFinite(carried) ? carried : null };
    }
  }
  return null;
};

/**
 * The sentence for a `4433` reason, or `undefined` for a reason that is not a byte-ceiling refusal (the caller keeps
 * the relay's words then). A relay too old to carry the reset is still described, with the reset stated as the rule it
 * follows rather than as a time this device would have to guess.
 */
export const hostedAllowanceSentence = (
  reason: string,
  formatTime: ClockTimeFormat = localClockTime,
): string | undefined => {
  const refusal = readRefusal(reason);
  if (refusal === null) return undefined;
  const resets =
    refusal.resetsAt !== null
      ? `resets at ${formatTime(refusal.resetsAt)}`
      : refusal.window === 'day'
        ? 'resets at midnight UTC'
        : 'resets within a minute';
  if (refusal.scope === 'daemon') {
    return refusal.window === 'day'
      ? `Today's relay data allowance for this machine is used up (${resets}). ${DIRECT_STILL_WORKS}`
      : `This machine has used its relay data allowance for this minute (${resets}). ${DIRECT_STILL_WORKS}`;
  }
  return refusal.window === 'day'
    ? `Ferretry's relay has used today's data allowance for every machine (${resets}). ${DIRECT_STILL_WORKS}`
    : `Ferretry's relay is at its data limit for this minute (${resets}). ${DIRECT_STILL_WORKS}`;
};
