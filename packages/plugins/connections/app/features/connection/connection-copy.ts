/**
 * EVERY WORD THE CONNECTION SURFACES SAY, in one place so a test pins them.
 *
 * A lost carrier used to reach the reader as the whole carrier walk's sentence — addresses, close codes,
 * both carriers — once per panel. These are the only sentences the pill and the details sheet may show;
 * the walk's technical text appears in the details sheet alone, one line per carrier.
 */

import type { CarrierFailure, LikelyCause } from '../../lib/connection-health.ts';

/** The pill's one word while the reconnect loop is working. */
export const RECONNECTING_LABEL = 'Reconnecting…';

/** "12 seconds", "3 minutes", "2 hours" — how long the outage has lasted, for the outage view. */
export const outageDuration = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const unit = (count: number, name: string): string => `${count} ${name}${count === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');
  return unit(Math.floor(minutes / 60), 'hour');
};

/** The outage view's own lines: how long, how many automatic attempts, and the one action. */
export const OUTAGE_COPY = {
  lostFor: (duration: string): string => `Lost ${duration} ago`,
  attempts: (attempt: number): string => (attempt === 1 ? '1 automatic attempt' : `${attempt} automatic attempts`),
  retryNow: 'Retry now',
} as const;

/** A stalled machine's heading and one sentence per likely cause. */
export interface StallCopy {
  readonly heading: string;
  readonly advice: string;
}

/**
 * Why a stalled machine is not answering, by cause — the details sheet's heading for that machine. "This device", not "your phone": the same banner shows on a laptop.
 * Each one says what most likely happened and the one thing the reader can do about it.
 */
export const stallCopy = (cause: LikelyCause, machine: string): StallCopy => {
  switch (cause) {
    case 'device-offline':
      return {
        heading: 'This device is offline',
        advice: 'Check Wi-Fi or mobile data. Ferretry reconnects on its own.',
      };
    case 'daemon-unreachable':
      return {
        heading: `${machine} is asleep or its daemon is stopped`,
        advice: 'Wake the machine, or start its daemon by running fyd on it.',
      };
    case 'relay-unreachable':
      return {
        heading: 'The relay is unreachable',
        advice: 'It usually comes back on its own. Switching to Wi-Fi can help meanwhile.',
      };
    case 'unknown':
      return { heading: `Can’t reach ${machine}`, advice: 'Still retrying on its own.' };
  }
};

/**
 * One line per carrier, whatever the caller handed in. The contract already deduplicates, but a carrier
 * listed twice would bring back exactly the repetition this surface exists to remove, so the sheet does
 * not trust it: the first entry for each label wins.
 */
export const carrierLines = (failures: readonly CarrierFailure[]): readonly CarrierFailure[] => {
  const seen = new Set<string>();
  return failures.filter(failure => {
    if (seen.has(failure.label)) return false;
    seen.add(failure.label);
    return true;
  });
};

/**
 * How long a RELAY-ONLY machine may stay unreachable before the card offers "Pair again": about the time its backoff
 * has been at its ten-second ceiling for a good while. Measured from the first failure of the outage (`since`), so a
 * recovered machine that fails again starts the count anew.
 */
export const PAIR_AGAIN_AFTER_MS = 10 * 60_000;

/**
 * The offer's words. It claims nothing: a relay-only browser cannot tell a reinstalled machine from a sleeping one
 * (a relay's `4404` reads the same), so the line only says what to do IF that is what happened.
 */
export const PAIR_AGAIN_COPY = {
  line: 'If Ferretry was reinstalled there, pair again.',
  button: 'Pair again',
} as const;

/** Whether an outage that began at `since` is old enough for {@link PAIR_AGAIN_COPY}, on the clock the card is drawn by. */
export const pairAgainOffered = (since: number, now: number): boolean => now - since >= PAIR_AGAIN_AFTER_MS;
