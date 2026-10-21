/**
 * What a person reads when Ferretry's hosted relay refuses a machine for bytes (`4433`).
 *
 * The relay's own words are an operator's ("per-daemon daily bandwidth ceiling is reached"); the
 * person holding the phone needs three facts instead: what ran out, when it comes back, and that the
 * machine is still reachable without the relay. The reset is the instant the relay carried in its
 * reason (`readHostedBandwidthRefusal` owns that grammar), shown in this device's local time.
 */

import { readHostedBandwidthRefusal } from '@ferretry/relay';

/** Renders an instant as a short local clock time. A parameter so a test can pin the locale. */
export type ClockTimeFormat = (epochMilliseconds: number) => string;

const localClockTime: ClockTimeFormat = epochMilliseconds =>
  new Date(epochMilliseconds).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const DIRECT_STILL_WORKS = 'Direct connections still work.';

/**
 * The sentence for a `4433` reason, or `undefined` for a reason that is not a byte-ceiling refusal
 * (the caller keeps the relay's words then). A relay too old to carry the reset is still described,
 * with the reset stated as the rule it follows rather than as a time this device would have to guess.
 */
export const hostedAllowanceSentence = (
  reason: string,
  formatTime: ClockTimeFormat = localClockTime,
): string | undefined => {
  const refusal = readHostedBandwidthRefusal(reason);
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
