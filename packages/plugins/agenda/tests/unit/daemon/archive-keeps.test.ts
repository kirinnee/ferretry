import { describe, expect, test } from 'bun:test';
import type { AsksApi } from '@ferretry/core-asks/contract';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { ArchiveKeeps, type ArchiveKeepSource, type FerretId } from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { Log } from '@ferretry/kernel/contract';
import { HookEngine } from '@ferretry/kernel/host';
import { definePlugin } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import agenda from '../../../daemon/index.ts';
import { agendaArchiveKeeps } from '../../../daemon/lib/archive-keeps.ts';
import manifest from '../../../manifest.ts';
import { raiseAsk } from './support.ts';

/**
 * Agenda's half of `session.archive-keeps` (ruling #46). The archive is OFF by default today and in 5.0 (no `afterHours`
 * in `archive.yaml`); this taker answers for when the owner turns it on. Today's rule (fyd.ts `hasOpenAgendaItem`): the
 * ferret's own agenda board holds an entry still `active` — an unanswered ask, an open notice or a parked item.
 */

const silent: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };
const never = () => ({ promise: new Promise<'timeout'>(() => {}), cancel: () => {} });

/** Ferrets' offer as its manifest declares it: the hook object its contract exports (core is never imported whole). */
const ferretsOffering = definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  hooks: { offers: [{ hook: ArchiveKeeps }] },
});

const id = (ferret: string) => ferret as FerretId;

const asked = (asks: Pick<AsksApi, 'snapshots'>) => {
  const source = agendaArchiveKeeps(asks);
  if (source.kind !== 'agenda') throw new Error('Agenda contributed something other than an agenda source');
  return async (ferret: string) => await source.hasOpenItem(id(ferret));
};

/** A board as Asks returns it, with only what the rule reads (the rest of a snapshot is not consulted). */
const board = (sessionId: string, items: number, parseErrors = 0) => ({
  sessionId,
  items: Array.from({ length: items }, (_, at) => ({ id: `A${at + 1}` })),
  parseErrors,
});
const stub = (answer: (filter: { readonly ferret?: string }) => Promise<readonly unknown[]>) =>
  ({ snapshots: answer }) as unknown as Pick<AsksApi, 'snapshots'>;

describe('AK-A Agenda answers the archive: an open item on the ferret’s own board', () => {
  test('AK-A1 an unanswered ask keeps its ferret; a board with none, or only answered and closed asks, does not', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'open-one', { kind: 'yesno' });
    const answered = await raiseAsk(asks, 'f2', 'done-one');
    await asks.close(answered, 'answered');
    const hasOpen = asked(asks);
    expect(await hasOpen('f1')).toBe(true);
    expect(await hasOpen('f2')).toBe(false);
    expect(await hasOpen('f3')).toBe(false);
  });

  test('AK-A2 an open notice keeps its ferret too (today every active entry kept, notices included)', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'heads-up', { kind: 'notice' });
    expect(await asked(asks)('f1')).toBe(true);
  });

  test('AK-A3 a parked (snoozed) item is still open, so it keeps its ferret', async () => {
    const parked = { ...board('f1', 1), items: [{ id: 'A1', parked: { reason: 'snoozed' } }] };
    expect(await asked(stub(async () => [parked]))('f1')).toBe(true);
  });

  test('AK-A4 no leak across ferrets: one ferret’s open ask never keeps another, and only its own board is asked', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'mine');
    const hasOpen = asked(asks);
    expect(await hasOpen('f1')).toBe(true);
    expect(await hasOpen('f2')).toBe(false);

    const seen: unknown[] = [];
    await asked(
      stub(async filter => {
        seen.push(filter);
        return [board('f2', 0)];
      }),
    )('f2');
    expect(seen).toEqual([{ ferret: 'f2' }]);
  });

  test('AK-A5 an answer that is not the ferret’s own board rejects (keep live), never stands in for it', async () => {
    // Another ferret's board with open items, and another ferret's empty board: neither is f1's answer.
    await expect(asked(stub(async () => [board('f2', 3)]))('f1')).rejects.toThrow('no agenda board answered for f1');
    await expect(asked(stub(async () => [board('f2', 0)]))('f1')).rejects.toThrow('no agenda board answered for f1');
    await expect(asked(stub(async () => []))('f1')).rejects.toThrow('no agenda board answered for f1');
  });

  test('AK-A6 a board that cannot be read rejects (keep live), never answers "nothing open"', async () => {
    const failing = stub(async () => {
      throw new Error('the agenda file is damaged');
    });
    await expect(asked(failing)('f1')).rejects.toThrow('the agenda file is damaged');
  });

  test('AK-A7 a board with entries that did not parse rejects (keep live) unless an open item already keeps it', async () => {
    await expect(asked(stub(async () => [board('f1', 0, 2)]))('f1')).rejects.toThrow('could not be read');
    expect(await asked(stub(async () => [board('f1', 1, 2)]))('f1')).toBe(true);
  });

  test('AK-A8 each ask reads the board afresh: once the ask is answered, the ferret is no longer kept', async () => {
    const asks = new FakeAsks();
    const ref = await raiseAsk(asks, 'f1', 'one');
    const hasOpen = asked(asks);
    expect(await hasOpen('f1')).toBe(true);
    await asks.close(ref, 'answered');
    expect(await hasOpen('f1')).toBe(false);
  });
});

describe('AK-A Agenda takes session.archive-keeps through Ferrets’ contract only', () => {
  test('AK-A9 the manifest takes the hook Ferrets offers, and the kernel plans it with no refusal and no new edge', () => {
    expect(manifest.hooks?.takes?.some(take => take.hook.name === ArchiveKeeps.name)).toBe(true);
    const { refusals, engine } = HookEngine.plan([ferretsOffering, manifest], silent, never);
    expect(refusals.filter(refusal => refusal.plugins.includes('agenda'))).toEqual([]);
    expect(engine.offererOf(ArchiveKeeps)).toBe('ferrets');
    expect(Object.keys(manifest.needs ?? {}).sort()).toEqual(['asks', 'ferrets']);
  });

  test('AK-A10 a real boot contributes ONE agenda source under Agenda’s id, answering from Asks', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'one');
    const taken: { hooks?: Record<string, unknown> } = {};
    const capturing = {
      ...agenda,
      build: (ctx: never) => {
        const half = (agenda.build as (ctx: never) => { hooks: Record<string, unknown> })(ctx);
        taken.hooks = half.hooks;
        return half;
      },
    } as typeof agenda;
    const host = await testHost({ plugins: [capturing], fakes: { asks, ferrets: new FakeFerrets() } });
    try {
      const contribute = taken.hooks?.['session.archive-keeps'] as () => readonly {
        readonly id: string;
        readonly item: ArchiveKeepSource;
      }[];
      const contributions = contribute();
      expect(contributions.map(each => [each.id, each.item.kind])).toEqual([['agenda', 'agenda']]);
      const [only] = contributions;
      if (only?.item.kind !== 'agenda') throw new Error('no agenda source');
      expect(await only.item.hasOpenItem(id('f1'))).toBe(true);
      expect(await only.item.hasOpenItem(id('f2'))).toBe(false);
    } finally {
      await host.stop();
    }
  });
});
