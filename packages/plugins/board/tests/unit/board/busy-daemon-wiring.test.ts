import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { Card } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { boot, TEST_IDENTITY } from '../../integration/daemon/harness.ts';
import { card, PROJECT } from './support.ts';

/**
 * The busy-daemon fix, held at the PRODUCTION wiring (`assemble`, the way the daemon builds it): the board's gate list
 * is ONE sweep for the whole board and the sweep stops with the daemon. The seam counted is Asks, the port every
 * ledger read goes through, so a board of N cards reading its ledgers once per card is a number, not a feeling.
 */

const CARDS = 3000;
const FERRETS = 20;

/** An Asks that counts every call made through it, by method (the real fake does the work). */
const counting = (): { readonly asks: FakeAsks; readonly calls: Map<string, number> } => {
  const target = new FakeAsks();
  const calls = new Map<string, number>();
  const asks = new Proxy(target, {
    get: (self, key) => {
      const value = Reflect.get(self, key, self) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(key), (calls.get(String(key)) ?? 0) + 1);
        return (value as (...all: unknown[]) => unknown).apply(self, args);
      };
    },
  });
  return { asks, calls };
};

/** 3000 generated cards in Todo over 20 ferrets, written into Board's own state before the daemon first reads it. */
const seed = async (host: Awaited<ReturnType<typeof boot>>['host']): Promise<readonly Card[]> => {
  const state = host.state('board').port(manifest.data.state);
  const def = manifest.data.state.find(file => file.name === 'cards');
  if (def === undefined) throw new Error('Board declares no cards file');
  const cards = Array.from({ length: CARDS }, (_, i) =>
    card({
      id: `F${i + 1}`,
      machineId: TEST_IDENTITY.daemonId,
      projectId: PROJECT as Card['projectId'],
      owner: `ferret-${i % FERRETS}`,
      assignee: `ferret-${(i + 1) % FERRETS}`,
    }),
  );
  for (const each of cards) await state.write(def as never, each as never, each.id);
  return cards;
};

describe('the board gate list through the real wiring (G1)', () => {
  it('should read every ledger once for 3000 cards, not once per card', async () => {
    // Arrange: the daemon's own Board half over a counting Asks, with 3000 cards on disk
    const { asks, calls } = counting();
    const world = await boot({ asks });
    const cards = await seed(world.host);
    const job = world.jobs.get('board-gates');
    if (job === undefined) throw new Error('Board registers no board-gates job');
    should(cards).have.length(CARDS);

    // Act: the gate reconcile, whose card list is `gateBoard.cards()`
    await job.run(new AbortController().signal);

    // Assert: one sweep reads each of the 20 ferrets' ledgers once, plus the reconcile's own single read of every open
    // card ask (`openAll`) and one of the answered ones. A per-card derivation reads 3000 times that.
    should(calls.get('open')).equal(FERRETS + 1);
    should(calls.get('answers')).equal(1);
  }, 120_000);
});
