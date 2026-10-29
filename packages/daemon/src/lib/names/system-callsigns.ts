import {
  nextSystemCallsignSequence,
  type SystemCallsignPrefix,
  systemCallsignName,
  systemCallsignSequence,
} from '@ferretry/protocol';
import type { SerialExecutor } from '../ports.ts';

/**
 * Issuing the callsign of a session Ferretry starts ITSELF — the Learning miner, Pack clean-up — so it
 * is `learning-000001` or `pack-00002A` and never a first name from the human pool.
 *
 * ONE COUNTER PER PREFIX, persisted, so a restart carries on rather than starting again from 1; the
 * Warden keeps its own in its state document. An id wraps to 1 after FFFFFF and skips every id the
 * fleet still holds. Issuing is serialized, so two sessions started together never read the same
 * counter.
 */

/** The last sequence issued for each prefix; a prefix never issued is absent. */
export type SystemCallsignCounters = Partial<Record<SystemCallsignPrefix, number>>;

/** The persisted counters. Reading is total: absent or damaged is "nothing issued yet". */
export interface SystemCallsignCounterStore {
  read(): Promise<SystemCallsignCounters>;
  write(counters: SystemCallsignCounters): Promise<void>;
}

export interface SystemCallsignIssuerPorts {
  readonly counters: SystemCallsignCounterStore;
  /** The callsigns the fleet holds right now, any shape. */
  readonly held: () => Promise<readonly string[]>;
  readonly serial: SerialExecutor;
}

export class SystemCallsignIssuer {
  constructor(private readonly ports: SystemCallsignIssuerPorts) {}

  /** The next free callsign for `prefix`, with the counter already advanced past it. */
  async next(prefix: SystemCallsignPrefix): Promise<string> {
    return await this.ports.serial.run(`system-callsign:${prefix}`, async () => {
      const [counters, held] = await Promise.all([this.ports.counters.read(), this.ports.held()]);
      const inUse = new Set<number>();
      for (const callsign of held) {
        const sequence = systemCallsignSequence(prefix, callsign);
        if (sequence !== undefined) inUse.add(sequence);
      }
      const sequence = nextSystemCallsignSequence(counters[prefix] ?? 0, inUse);
      if (sequence === undefined) throw new Error(`every ${prefix} callsign is in use`);
      await this.ports.counters.write({ ...counters, [prefix]: sequence });
      return systemCallsignName(prefix, sequence);
    });
  }
}

/**
 * Starts a system session under its own callsign: `start` is handed the id, and when the start is
 * refused because that id was taken the next one is issued and the start retried ONCE. Any other
 * failure, and a second refusal, reach the caller unchanged.
 */
export async function startWithSystemCallsign<T>(
  issuer: SystemCallsignIssuer,
  prefix: SystemCallsignPrefix,
  isTaken: (error: unknown) => boolean,
  start: (teammate: string) => Promise<T>,
): Promise<T> {
  try {
    return await start(await issuer.next(prefix));
  } catch (error) {
    if (!isTaken(error)) throw error;
    return await start(await issuer.next(prefix));
  }
}
