/**
 * ONE MACHINE THAT IS NOT ANSWERING, SAID ABOUT THAT MACHINE AND NOTHING ELSE.
 *
 * With two machines paired and one asleep, the owner saw the whole Sessions page fail: a banner pinned
 * over the header and "+ New", a red page-level "could not reach fyd at <a loopback address> (…)", and
 * an "Updating…" pill waiting on the machine that was down — while the healthy machine's sessions sat
 * underneath, unusable. One machine's outage is a fact about that machine, so it is said in that
 * machine's own place (its heading in the list, its own page's status row), in words a person reads:
 * "Liftoff MBP isn't reachable right now". The transport's sentence — an address, a close code, which
 * carrier said what — is kept, but only behind Details.
 *
 * Pure: the health model's fact, the fleet slice's last read, and the machine's name in; words out.
 */

import type { CarrierFailure, ConnectionHealthState, LikelyCause } from './connection-health.ts';
import type { DaemonFleetSlice } from './fleet-store.ts';

/** Why this machine's rows are not live, in the vocabulary the chip and the Details sheet share. */
export type OutageReason = LikelyCause | 'not-answering' | 'refresh-failed';

/** One machine's outage, as every surface that names it says it. */
export interface MachineOutage {
  readonly name: string;
  readonly reason: OutageReason;
  /** The chip's words: "Asleep · retrying". Short enough for a phone's machine heading. */
  readonly chip: string;
  /** The sentence for people: "Liftoff MBP isn't reachable right now". */
  readonly headline: string;
  /** The one thing the reader can do about it. */
  readonly advice: string;
  /** The reconnect loop is working on it, so Retry now only jumps the queue. */
  readonly retrying: boolean;
  /** When the outage began, if the health model measured it. */
  readonly since: number | null;
  /** Automatic attempts so far, if the health model is retrying. */
  readonly attempt: number | null;
  /** The last good list read: what "as of 23:05" says. `null` when nothing was ever read. */
  readonly readAt: number | null;
  /** The raw text, one line per carrier or request — for the Details sheet only, never the page. */
  readonly technical: readonly CarrierFailure[];
}

/** What the last failed list read said, as a Details line. */
const LAST_REQUEST_LABEL = 'Last request';

const CHIP_WORD: Readonly<Record<OutageReason, string>> = {
  'daemon-unreachable': 'Asleep',
  'device-offline': 'No network',
  'relay-unreachable': 'Relay down',
  unknown: 'Unreachable',
  'not-answering': 'Not answering',
  'refresh-failed': 'Refresh failed',
};

const ADVICE: Readonly<Record<OutageReason, string>> = {
  'daemon-unreachable': 'Wake the machine, or start its daemon by running fyd on it.',
  'device-offline': 'Check Wi-Fi or mobile data. Ferretry reconnects on its own.',
  'relay-unreachable': 'The relay usually comes back on its own. Switching to Wi-Fi can help meanwhile.',
  unknown: 'Still retrying on its own.',
  'not-answering': 'It may be busy or asleep. The list is read again on its own.',
  'refresh-failed': 'The list is read again on its own, or try now.',
};

const headlineFor = (reason: OutageReason, name: string): string => {
  if (reason === 'device-offline') return 'This device is offline';
  if (reason === 'refresh-failed') return `${name} couldn’t refresh its sessions`;
  if (reason === 'not-answering') return `${name} isn’t answering right now`;
  return `${name} isn’t reachable right now`;
};

/** A read that ended in a timeout reads as "not answering", not as a broken daemon. */
export const NOT_ANSWERING_MARK = 'did not answer within';

/**
 * This machine's outage, or `null` while it is answering. Reconnecting is an outage from its first
 * measurement — the list already greys on it — and a failed list read is one even on a machine whose
 * carrier is fine, because the rows on screen are then not what the machine holds now.
 */
export const machineOutage = (
  name: string,
  health: ConnectionHealthState,
  slice: Pick<DaemonFleetSlice, 'status' | 'error' | 'readAt'>,
): MachineOutage | null => {
  const reconnecting = health.kind === 'reconnecting' ? health : null;
  const failed = slice.status === 'error' || (slice.status === 'loading' && slice.error !== null);
  if (reconnecting === null && !failed) return null;
  const listError = slice.error ?? '';
  const reason: OutageReason =
    reconnecting !== null
      ? reconnecting.cause
      : listError.includes(NOT_ANSWERING_MARK)
        ? 'not-answering'
        : 'refresh-failed';
  return describe(name, reason, reconnecting, slice);
};

/**
 * A machine some other fact already called offline — its list's reach — when neither its health nor
 * its last read holds a failure to name. It still gets a heading that says so, never a blank reason.
 */
export const unreachableOutage = (name: string, slice: Pick<DaemonFleetSlice, 'error' | 'readAt'>): MachineOutage =>
  describe(name, 'unknown', null, slice);

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

const describe = (
  name: string,
  reason: OutageReason,
  reconnecting: Reconnecting | null,
  slice: Pick<DaemonFleetSlice, 'error' | 'readAt'>,
): MachineOutage => {
  const listError = slice.error ?? '';
  const retrying = reconnecting !== null;
  const technical = [
    ...(reconnecting?.failures ?? []),
    ...(listError === '' ? [] : [{ label: LAST_REQUEST_LABEL, detail: listError }]),
  ];
  return {
    name,
    reason,
    chip: retrying ? `${CHIP_WORD[reason]} · retrying` : CHIP_WORD[reason],
    headline: headlineFor(reason, name),
    advice: ADVICE[reason],
    retrying,
    since: reconnecting?.since ?? null,
    attempt: reconnecting?.attempt ?? null,
    readAt: slice.readAt ?? null,
    technical,
  };
};

/** Why the rows under an outage cannot be acted on — the title their read-only wrapper carries. */
export const readOnlyReason = (outage: MachineOutage): string =>
  `${outage.headline}. These sessions are its last known state and are read-only until it answers.`;
