import type { AgendaFerretsContext } from '../../contract/index.ts';
import { MACHINE_AGENDA_ID } from '../lib/protocol/agenda.ts';
import type { AgendaFerretLifecycle, AgendaDeliveryPorts } from '../lib/agenda/index.ts';

/**
 * The reply batcher's lifecycle port over Ferrets' half of `agenda.context` (read at each look). It says `stopped` or
 * `gone` only on Ferrets' own typed record: a configuration with `live: false`, or a registry that does not hold the
 * ferret at all. Ferrets off, a failed read, a ferret it knows but cannot describe and the machine agenda are
 * `unknown`, which closes nothing.
 */
export function ferretLifecycle(source: (key: 'ferrets') => unknown): NonNullable<AgendaDeliveryPorts['lifecycle']> {
  return {
    state: async (sessionId): Promise<AgendaFerretLifecycle> => {
      if (sessionId === MACHINE_AGENDA_ID) return 'unknown';
      const found = source('ferrets');
      if (found === 'unavailable') return 'unknown';
      const ferrets = found as AgendaFerretsContext;
      try {
        const session = await ferrets.get(sessionId);
        if (session !== undefined) return session.live === false ? 'stopped' : 'live';
        return (await ferrets.has(sessionId)) ? 'unknown' : 'gone';
      } catch {
        return 'unknown';
      }
    },
  };
}
