import { describe, expect, it, spyOn } from 'bun:test';
import { FerretTerminalOwnerDirectory } from '../../../../daemon/adapters/terminal/owner-directory.ts';
import { ManagedTerminalService } from '../../../../daemon/adapters/terminal/service.ts';
import { type fakeFerrets, FakeTerminalRuntime, FERRET, ferretSummary } from '../../../support/daemon/half.ts';

async function subject(get: ReturnType<typeof fakeFerrets>['get']) {
  const owners = new FerretTerminalOwnerDirectory({ get });
  const runtime = new FakeTerminalRuntime();
  await runtime.create({
    ownerId: FERRET,
    id: '0123456789ab',
    title: 'dev',
    cwd: '/work/hadi',
    size: { cols: 80, rows: 24 },
  });
  const kill = spyOn(runtime, 'kill');
  const service = new ManagedTerminalService(
    runtime,
    { resolve: async () => ({ id: FERRET, cwd: '/work/hadi' }) },
    { now: () => 0 },
    { next: () => '0123456789ab' },
    { owners },
  );
  return { owners, runtime, kill, service };
}

describe('Ferrets terminal owner directory', () => {
  for (const malformed of [
    {},
    { name: 'still here' },
    { ...ferretSummary(), role: 'helper', state: 'unknown-state' },
  ]) {
    it(`a malformed owner result (${Object.keys(malformed).join(',') || 'empty'}) is live/unknown and the sweep never kills`, async () => {
      const { owners, runtime, kill, service } = await subject(async () => malformed as never);

      expect(await owners.standing(FERRET)).toEqual({ standing: 'live', status: 'unknown', label: FERRET });
      expect((await service.closeFinished('sweep')).closed).toBe(0);
      expect(kill).not.toHaveBeenCalled();
      expect(runtime.records).toHaveLength(1);
    });
  }

  for (const synchronous of [false, true]) {
    it(`a ${synchronous ? 'throwing' : 'rejecting'} get is live/unknown and closeFinished never kills its terminals`, async () => {
      const { owners, runtime, kill, service } = await subject(() => {
        if (synchronous) throw new Error('owner store unavailable');
        return Promise.reject(new Error('owner store unavailable'));
      });

      expect(await owners.standing(FERRET)).toEqual({ standing: 'live', status: 'unknown', label: FERRET });
      const result = await service.closeFinished('sweep');

      expect(result.closed).toBe(0);
      expect(kill).not.toHaveBeenCalled();
      expect(runtime.records).toHaveLength(1);
    });
  }

  it('a successful absent lookup proves the owner is gone and permits reclamation', async () => {
    const { owners, kill, service } = await subject(async () => undefined);

    expect(await owners.standing(FERRET)).toEqual({ standing: 'gone', status: 'removed', label: FERRET });
    expect((await service.closeFinished('sweep')).closed).toBe(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('a known live owner keeps its name and state', async () => {
    const { owners, kill, service } = await subject(async () => ({ ...ferretSummary(), role: 'helper' }));

    expect(await owners.standing(FERRET)).toEqual({ standing: 'live', status: 'working', label: 'Hadi' });
    expect((await service.closeFinished('sweep')).closed).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
