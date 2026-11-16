import type { AgendaContextSession, AgendaFerretsContext } from '@ferretry/core-asks/contract';
import type { FerretRegistry } from '../lib/registry/registry.ts';

/**
 * Ferrets' half of `agenda.context` (key `ferrets`): which ferrets exist and who started whom, read from the registry
 * the daemon already keeps. Asks reads it at each call to decide whether a ferret may raise an agenda item (a helper may
 * not) and where a notice lands, so every answer is the registry's own and none is a guess: an unknown ferret has no
 * lead, is not there, and answers no document.
 *
 * `ready` resolves once the held records are loaded; a read before then would see no ferret.
 */
export function ferretsAgendaContext(registry: FerretRegistry, ready: () => Promise<void>): AgendaFerretsContext {
  return {
    has: async ferret => {
      await ready();
      return registry.get(ferret as never) !== undefined;
    },
    leadOf: async ferret => {
      await ready();
      return registry.get(ferret as never)?.parent;
    },
    // `fy send` addresses a ferret by its callsign, else by its id.
    addressOf: async ferret => {
      await ready();
      return registry.get(ferret as never)?.name ?? ferret;
    },
    get: async ferret => {
      await ready();
      const record = registry.get(ferret as never);
      if (record === undefined) return undefined;
      const session: AgendaContextSession = {
        id: record.id,
        ...(record.parent === undefined ? {} : { parent: record.parent }),
        ...(record.provenance === undefined ? {} : { origin: record.provenance.origin }),
        mode: record.mode ?? 'auto',
        ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
        updatedAt: record.stateAt,
        live: record.state !== 'stopped',
      };
      return session;
    },
    all: async () => {
      await ready();
      return registry.list().map(record => record.id);
    },
  };
}
