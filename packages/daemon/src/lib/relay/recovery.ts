/**
 * WHAT A RECOVERED RELAY LOOKUP MAY DO WITH ITS ANSWER, AND WHEN IT MUST DO NOTHING.
 *
 * {@link RelayLookupRetry} settles with an answer; this decides whether that answer still means anything.
 * It can arrive minutes after the boot that asked, and two things can have happened to the daemon in the
 * meantime that the boot's own decision knew nothing about:
 *
 * - THE OPERATOR WROTE A `relay` BLOCK. An explicit entry — `enabled: false` included — always wins, and
 *   a switch-off written while discovery was failing is the emergency stop. A late success that started
 *   the hosted carrier anyway would turn that stop into a suggestion. So the CURRENT relay entries are
 *   read again, and recovery goes ahead only while they are exactly the entries the boot decided from;
 *   a changed document, or one that cannot be read, drops the answer (fail closed).
 * - THE DAEMON IS STOPPING. A recovery that finishes during shutdown must not start a carrier, least of
 *   all one whose storage has already closed. The owner's stopping flag is consulted after EVERY await.
 *
 * THE CHECK IS REPEATED RIGHT BEFORE THE CARRIER STARTS, because building one is itself asynchronous and
 * the document can change inside that window. The last check and the start are the same synchronous step,
 * so nothing can intervene between them.
 *
 * IT OWNS NO SOCKET. The carriers, their release and the published set are the caller's, handed in as
 * ports — which keeps every one of these orderings testable without a network or a daemon.
 */

import type { DaemonRelayCarrierEntry } from '../runtime/carriers.ts';
import { chooseRelayCarrierSources, dialledRelayUrl, type RelayCarrierSource } from './discovery.ts';
import { newlyDiscoveredRelays, type RelayLookupSettled } from './lookup-retry.ts';

/** The slice of a relay carrier recovery drives. */
export interface RecoverableCarrier {
  start(): void;
  stop(): void | Promise<void>;
}

export interface RecoveredCarrier<C extends RecoverableCarrier> {
  readonly carrier: C;
  readonly source: RelayCarrierSource;
}

export interface RelayRecoveryPorts<C extends RecoverableCarrier> {
  /** The relay entries the boot resolved its sources from. */
  readonly bootRelays: readonly DaemonRelayCarrierEntry[];
  /** Why the boot-time read failed, for the sentence that reports the recovery. */
  readonly bootFailure: string;
  /** The sources in force now; changes only when a recovery succeeds. */
  readonly sourcesNow: () => readonly RelayCarrierSource[];
  /** The relay entries in force RIGHT NOW. Rejecting means the configuration cannot be read. */
  readonly readCurrentRelays: () => Promise<readonly DaemonRelayCarrierEntry[]>;
  /** Whether the daemon has begun to stop (or this recovery was stopped). */
  readonly stopped: () => boolean;
  /** The caller's carrier factory, the same one the boot used. */
  readonly build: (
    fresh: readonly RelayCarrierSource[],
  ) => Promise<{ readonly carriers: readonly RecoveredCarrier<C>[] } | { readonly refusal: string }>;
  /** Registers a carrier's release; called BEFORE it is started. */
  readonly hold: (carrier: C) => void;
  /** Replaces the published relay sources. */
  readonly publish: (sources: readonly RelayCarrierSource[]) => void;
  readonly say: (line: string) => void;
}

/** Whether two relay entry lists are the same document, entry for entry and in order. */
function sameRelayEntries(a: readonly DaemonRelayCarrierEntry[], b: readonly DaemonRelayCarrierEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Ends a carrier that was built and is not going to run. A failing stop is not this recovery's to report. */
async function discard<C extends RecoverableCarrier>(carriers: readonly RecoveredCarrier<C>[]): Promise<void> {
  for (const { carrier } of carriers) {
    try {
      await carrier.stop();
    } catch {
      // Intentionally ignored: it was never started.
    }
  }
}

export async function recoverRelays<C extends RecoverableCarrier>(
  ports: RelayRecoveryPorts<C>,
  settled: RelayLookupSettled,
): Promise<void> {
  const { advertisement, attempts } = settled;
  const asked = `the relay directory answered on read ${String(attempts)}`;
  /**
   * `true` while this answer may still be acted on. Reads the CURRENT relay entries, so it is awaited,
   * and is therefore always followed by a look at the stopping flag.
   */
  const stillPermitted = async (): Promise<boolean> => {
    let current: readonly DaemonRelayCarrierEntry[];
    try {
      current = await ports.readCurrentRelays();
    } catch {
      if (!ports.stopped())
        ports.say(`${asked}, but this daemon's relay configuration cannot be read now, so no relay carrier is started`);
      return false;
    }
    if (ports.stopped()) return false;
    if (sameRelayEntries(ports.bootRelays, current)) return true;
    ports.say(
      `${asked}, but the relay configuration changed while it was failing — an explicit entry wins, so no relay carrier is started from it`,
    );
    return false;
  };

  if (ports.stopped()) return;
  if (!(await stillPermitted())) return;

  const next = chooseRelayCarrierSources(ports.bootRelays, advertisement);
  if (next.kind === 'refused') {
    ports.say(`relay carrier configuration refused — ${asked}, and ${next.reason}`);
    return;
  }
  const fresh = newlyDiscoveredRelays(ports.sourcesNow(), next.sources);
  if (fresh.length === 0) {
    // A definitive answer: said once, and the posture it leaves is the one the boot already described.
    const why =
      advertisement.kind === 'undetermined'
        ? advertisement.reason
        : 'Ferretry’s relay is switched off right now, so there is no carrier to fall back to';
    ports.say(`${asked} — ${why}; this daemon stays direct-only`);
    return;
  }

  const made = await ports.build(fresh);
  if (!('carriers' in made)) {
    if (!ports.stopped()) ports.say(`no relay carriers — ${made.refusal}`);
    return;
  }
  if (ports.stopped()) {
    await discard(made.carriers);
    return;
  }
  // The configuration is read AGAIN: building was asynchronous, and the document can change inside it.
  if (!(await stillPermitted())) {
    await discard(made.carriers);
    return;
  }

  // Nothing below awaits: the check above and the start are one step.
  const dialled: string[] = [];
  for (const { carrier, source } of made.carriers) {
    ports.hold(carrier);
    carrier.start();
    const url = dialledRelayUrl(source);
    if (url !== undefined) dialled.push(url);
  }
  ports.publish(next.sources);
  ports.say(
    `relay carrier recovered — ${asked}, after the boot-time read failed (${ports.bootFailure}); now dialling ${dialled.join(', ')}`,
  );
}
