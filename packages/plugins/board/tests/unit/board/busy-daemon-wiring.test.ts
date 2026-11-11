import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { Card } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { as, boot, makeCard, TEST_IDENTITY } from '../../integration/daemon/harness.ts';
import { card, PROJECT } from './support.ts';

/**
 * The busy-daemon fix, held at the PRODUCTION wiring (`assemble`, the way the daemon builds it): the board's gate list
 * is ONE sweep for the whole board and the sweep stops with the daemon. The seam counted is Asks, the port every
 * ledger read goes through, so a board of N cards reading its ledgers once per card is a number, not a feeling.
 */

const CARDS = 3000;
const FERRETS = 20;

/**
 * An Asks that counts every call made through it, by method (the real fake does the work). `onCall` runs on each call
 * with its method and its running count, before the call is made.
 */
const counting = (
  onCall: (method: string, count: number) => void = () => undefined,
): { readonly asks: FakeAsks; readonly calls: Map<string, number> } => {
  const target = new FakeAsks();
  const calls = new Map<string, number>();
  const asks = new Proxy(target, {
    get: (self, key) => {
      const value = Reflect.get(self, key, self) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const count = (calls.get(String(key)) ?? 0) + 1;
        calls.set(String(key), count);
        onCall(String(key), count);
        return (value as (...all: unknown[]) => unknown).apply(self, args);
      };
    },
  });
  return { asks, calls };
};

/**
 * Generated cards in Todo over `ferrets` ferrets, written into Board's own state before the daemon first reads it. The
 * first `gated` of them sit in the default board's try-it gate lane instead, with what that gate needs to ask the owner.
 */
const seed = async (
  host: Awaited<ReturnType<typeof boot>>['host'],
  ferrets: number,
  gated = 0,
): Promise<readonly Card[]> => {
  const state = host.state('board').port(manifest.data.state);
  const def = manifest.data.state.find(file => file.name === 'cards');
  if (def === undefined) throw new Error('Board declares no cards file');
  const cards = Array.from({ length: CARDS }, (_, i) => {
    const base = {
      id: `F${i + 1}`,
      machineId: TEST_IDENTITY.daemonId,
      projectId: (i < gated ? 'unfiled' : PROJECT) as Card['projectId'],
      owner: `ferret-${i % ferrets}`,
      assignee: `ferret-${(i + 1) % ferrets}`,
    };
    return i >= gated
      ? card(base)
      : card({
          ...base,
          laneId: 'to-test',
          summary: `Gate card ${String(i + 1)}`,
          howToTest: '1. Open the Inbox\n2. Answer the card',
          history: [{ seq: 1, at: card().createdAt, actor: card().createdBy, type: 'created', laneId: 'to-test' }],
        });
  });
  for (const each of cards) await state.write(def as never, each as never, each.id);
  return cards;
};

describe('the board gate list through the real wiring (G1)', () => {
  it('should read every ledger once for 3000 cards, not once per card', async () => {
    // Arrange: the daemon's own Board half over a counting Asks, with 3000 cards on disk, 5 of them at a gate
    const { asks, calls } = counting();
    const world = await boot({ asks });
    const cards = await seed(world.host, FERRETS, 5);
    const job = world.jobs.get('board-gates');
    if (job === undefined) throw new Error('Board registers no board-gates job');
    should(cards).have.length(CARDS);

    // Act: the gate reconcile, whose card list is `gateBoard.cards()`
    await job.run(new AbortController().signal);

    // Assert: one sweep reads the open card asks once (not once per ferret's ledger), plus the reconcile's own single
    // read of every open card ask (`openAll`) and one of the answered ones, and each of the 5 asks raised reads its
    // own ledger once more. A per-card derivation reads 3000 times that.
    should(calls.get('open')).equal(1 + 1 + 5);
    should(calls.get('answers')).equal(1 + 5);
    // And the cards at a gate came out of that one list with their content: each asks the owner about its own card
    const raised = await asks.open({});
    should(raised.map(each => each.entry).sort()).eql([1, 2, 3, 4, 5].map(n => `gate:F${String(n)}:to-test:1`).sort());
    should(raised.map(each => each.subject).sort()).eql(
      [1, 2, 3, 4, 5].map(n => `Try it: Gate card ${String(n)}`).sort(),
    );
  }, 120_000);
});

describe('the board sweep reads the board afresh on every pass (G3)', () => {
  it('should raise the ask of a card that reached its gate between two passes, without the write hook having asked', async () => {
    // Arrange: a card in Todo and a first pass over it. Asks refuses a raise while `refusing`, so the write that moves
    // the card to its gate (which tells the gates, and is swallowed when they cannot ask) leaves it at the gate unasked.
    let refusing = false;
    const target = new FakeAsks();
    const asks = new Proxy(target, {
      get: (self, key) => {
        const value = Reflect.get(self, key, self) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          key === 'raise' && refusing
            ? Promise.reject(new Error('Asks is down'))
            : (value as (...all: unknown[]) => unknown).apply(self, args);
      },
    });
    const world = await boot({ asks });
    const job = world.jobs.get('board-sweep');
    if (job === undefined) throw new Error('Board registers no board-sweep job');
    const made = await makeCard(world.host, { howToTest: 'Open the badge and look at its colour.' });
    const move = async (to: string) =>
      await world.host.request('POST', `/v1/board/cards/${made.id}`, {
        body: { action: 'move', to, reason: 'for the test' },
        headers: as('owner'),
      });
    await job.run(new AbortController().signal);
    should(await target.open({})).have.length(0);

    // Act: the card moves to the gate while Asks refuses, then pass two runs with Asks back
    refusing = true;
    should((await move('doing')).status).equal(200);
    should((await move('to-test')).status).equal(200);
    await world.host.settle();
    refusing = false;
    should(await target.open({})).have.length(0);
    await job.run(new AbortController().signal);

    // Assert: pass two read the card where it is now, so its ask is raised (a card list kept from pass one would
    // judge it by Todo and raise nothing)
    const open = await target.open({});
    should(open).have.length(1);
    should(open[0]?.entry.startsWith(`gate:${made.id}:to-test:`)).be.true();
  }, 120_000);
});

/** Asks that stops the sweep the moment its first ledger is read, the way the daemon's stop does mid-pass. */
const stoppedAtFirstRead = () => {
  const stop = new AbortController();
  const { asks, calls } = counting(method => {
    if (method === 'open') stop.abort();
  });
  return { stop, asks, calls };
};

describe('the board sweep stops with the daemon (G2)', () => {
  it('should make the one card-ask read and no more once stopped at that read', async () => {
    // Arrange: 3000 cards over 100 ferrets; the stop comes with the first (and only) Asks read
    const { stop, asks, calls } = stoppedAtFirstRead();
    const world = await boot({ asks });
    await seed(world.host, 100);
    const job = world.jobs.get('board-sweep');
    if (job === undefined) throw new Error('Board registers no board-sweep job');

    // Act: the job as the kernel runs it, with the stop signal
    const outcome = await job.run(stop.signal).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: the sweep ended with the stop's own reason, at the one Asks read; nothing was read after it
    should(outcome).equal(stop.signal.reason);
    should(calls.get('open')).equal(1);
  }, 120_000);

  it('should plan, nudge and remember nothing once the stop came before the plan', async () => {
    // Arrange: the stop lands in the only Asks read; the sweep must end the tick before it plans or writes its memory
    const { stop, asks } = stoppedAtFirstRead();
    const world = await boot({ asks });
    await seed(world.host, 10);
    const job = world.jobs.get('board-sweep');
    const memory = manifest.data.state.find(file => file.name === 'sweep');
    if (job === undefined || memory === undefined) throw new Error('Board registers no board-sweep job or sweep file');

    // Act
    const outcome = await job.run(stop.signal).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(outcome).equal(stop.signal.reason);
    should(world.host.state('board').raw(memory)).be.undefined();
  }, 120_000);
});
