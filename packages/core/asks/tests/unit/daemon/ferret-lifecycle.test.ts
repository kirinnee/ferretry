import { describe, expect, it } from 'bun:test';
import { ferretLifecycle } from '../../../daemon/adapters/ferret-lifecycle.ts';
import { MACHINE_AGENDA_ID } from '../../../daemon/lib/protocol/agenda.ts';

const session = (live?: boolean) => ({ id: 'f1', mode: 'auto', updatedAt: '2026-11-06T09:00:00.000Z', live });
const lifecycle = (ferrets: unknown) => ferretLifecycle(() => ferrets);

describe('the lifecycle Ferrets states for the reply batcher', () => {
  it('should say stopped only for a record Ferrets marks not live', async () => {
    expect(await lifecycle({ get: async () => session(false) }).state('f1')).toBe('stopped');
  });

  it('should say live for a record that is live or does not say', async () => {
    expect(await lifecycle({ get: async () => session(true) }).state('f1')).toBe('live');
    expect(await lifecycle({ get: async () => session() }).state('f1')).toBe('live');
  });

  it('should say gone only when the registry holds no such ferret', async () => {
    expect(await lifecycle({ get: async () => undefined, has: async () => false }).state('f1')).toBe('gone');
    expect(await lifecycle({ get: async () => undefined, has: async () => true }).state('f1')).toBe('unknown');
  });

  it('should say unknown, closing nothing, for Ferrets off, a failed read or the machine agenda', async () => {
    expect(await lifecycle('unavailable').state('f1')).toBe('unknown');
    expect(
      await lifecycle({
        get: async () => {
          throw new Error('unreadable');
        },
      }).state('f1'),
    ).toBe('unknown');
    expect(await lifecycle({ get: async () => undefined, has: async () => false }).state(MACHINE_AGENDA_ID)).toBe(
      'unknown',
    );
  });
});
