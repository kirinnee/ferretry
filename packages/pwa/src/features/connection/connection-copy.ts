/**
 * EVERY WORD THE CONNECTION SURFACES SAY, in one place so a test pins them.
 *
 * A lost carrier used to reach the reader as the whole carrier walk's sentence — addresses, close codes,
 * both carriers — once per panel. These are the only sentences the pill and the details sheet may show;
 * the walk's technical text appears in the details sheet alone, one line per carrier.
 */

import type { CarrierFailure, ConnectionHealthState, LikelyCause } from '../../lib/connection-health.ts';

/** The pill's one word while the reconnect loop is working. */
export const RECONNECTING_LABEL = 'Reconnecting…';

/** The pill once a machine has stalled: its name for one, a count for more — never a sentence. */
export const offlineLabel = (names: readonly string[]): string =>
  names.length === 1 ? `${names[0]} offline` : `${names.length} machines offline`;

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

/**
 * The pill's second, quieter half, or `null` when it has nothing to add.
 *
 * The attempt count wins once there has been a retry, because "attempt 4" says the loop is still at it;
 * before that a scheduled first retry counts down instead. A retry in flight says nothing more.
 */
export const pillDetail = (state: Reconnecting, now: number): string | null => {
  if (state.attempt >= 2) return `attempt ${state.attempt}`;
  if (state.nextAttemptAt === null) return null;
  const seconds = Math.ceil((state.nextAttemptAt - now) / 1000);
  return seconds >= 1 ? `retrying in ${seconds}s` : null;
};

/** "12 seconds", "3 minutes", "2 hours" — how long the outage has lasted, for the details sheet. */
export const outageDuration = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const unit = (count: number, name: string): string => `${count} ${name}${count === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');
  return unit(Math.floor(minutes / 60), 'hour');
};

/** The details sheet's plain-language lines. */
export const DETAILS_COPY = {
  title: 'Connection',
  reconnecting: (machine: string): string => `Trying to reach ${machine} again. What you see is kept until it answers.`,
  connected: (machines: readonly string[]): string =>
    machines.length === 1 ? `Connected to ${machines[0]}.` : 'Every machine is connected.',
  lostFor: (duration: string): string => `Lost ${duration} ago`,
  attempts: (attempt: number): string => (attempt === 1 ? '1 automatic attempt' : `${attempt} automatic attempts`),
  technical: 'What each route said',
  retryNow: 'Retry now',
  close: 'Close connection details',
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
