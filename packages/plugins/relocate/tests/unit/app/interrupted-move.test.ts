import { expect, test } from 'bun:test';
import { carry, review, type Machine } from '../../../app/lib/move.ts';
import { FERRET } from '../../support/fake-ferrets.ts';
import { targetWorld } from '../../support/target.ts';
import { world } from '../../support/world.ts';

for (const expireAt of ['receipt', 'import', 'fence', 'start'] as const)
  for (const interruption of ['none', 'before-fence', 'lost-fence-answer', 'after-start'] as const)
    test(`real export/import: ${interruption}, expiry at ${expireAt}, never two runnable copies`, async () => {
      const a = await world();
      a.now = Date.now();
      const b = await targetWorld({ nowMs: a.now }, a.fixture.remote);
      let targetRunning = false;
      let fenced = false;
      const assertSafe = () =>
        expect(Number(a.ferrets.state !== 'stopped') + Number(targetRunning)).toBeLessThanOrEqual(1);
      const expire = async () => {
        a.now += 20 * 60_000;
        await a.relocation.expire();
        assertSafe();
      };
      const machine = (
        daemon: string,
        name: string,
        call: (route: string, init: any) => Promise<unknown>,
      ): Machine => ({
        daemon,
        name,
        press: async act => await act(),
        client: {
          call: (async (route, init) => {
            assertSafe();
            const result = await call(route, init ?? {});
            assertSafe();
            return result;
          }) as Machine['client']['call'],
        },
      });
      const source = machine(a.sourceIdentity.daemonId, 'A', async (route, { params, body }) => {
        if (route.endsWith('/preflight')) return await a.relocation.preflight(FERRET, body.to);
        if (route.endsWith('/export')) return await a.relocation.export(FERRET, body.offer);
        if (route.includes('/chunks/')) return a.relocation.chunk(params.exportId, Number(params.index));
        if (route.endsWith('/complete')) {
          if (interruption === 'before-fence') throw new Error('A is unreachable');
          const result = await a.relocation.complete(params.exportId, body);
          fenced = true;
          if (expireAt === 'fence') await expire();
          if (interruption === 'lost-fence-answer') throw new Error('A’s answer was lost');
          return result;
        }
        throw new Error('unexpected source route');
      });
      const target = machine(b.daemonId, 'B', async (route, { params, body }) => {
        if (route.endsWith('/offers')) return await b.offers.open();
        if (route.endsWith('/preflight')) return await b.importer.preflight(params.offerId, body);
        if (route.startsWith('PUT ')) {
          b.importer.receive(params.offerId, Number(params.index), Buffer.from(body.chunk, 'base64url'));
          return { index: Number(params.index) };
        }
        if (route.endsWith('/import')) {
          const result = await b.importer.import(params.offerId, body);
          targetRunning = b.started.some(request => request.relocated?.pending !== true);
          assertSafe();
          if (expireAt === 'import') await expire();
          return result;
        }
        if (route.endsWith('/start')) {
          expect(fenced).toBe(true);
          targetRunning = true;
          if (expireAt === 'start') await expire();
          if (interruption === 'after-start') throw new Error('B’s answer was lost');
          return {};
        }
        throw new Error('unexpected target route');
      });
      const moved = await carry(FERRET, source, target, await review(FERRET, source, target));
      await expire();
      if (interruption === 'before-fence' || interruption === 'lost-fence-answer') {
        expect(targetRunning).toBe(false);
        expect(moved.received.recovery?.state).toBe('stopped');
        expect(moved.received.recovery?.message).toContain('confirm');
      } else expect(targetRunning).toBe(true);
      if (fenced) expect(a.ferrets.state).toBe('stopped');
    });
