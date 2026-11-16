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
