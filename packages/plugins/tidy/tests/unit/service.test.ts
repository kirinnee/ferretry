import { describe, expect, test } from 'bun:test';
import { FakeAsks, entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fakeBoard } from '@ferretry/plugin-board/contract/testing';
import type { BoardApi } from '@ferretry/plugin-board/contract';
import { TidyPlanSchema } from '../../contract/index.ts';
import { TidyService } from '../../daemon/lib/service.ts';

const ME = ferretId('lead');
const OTHER = ferretId('helper');

/** The fake board with every card read as an agent's, and each project's switch scripted. */
function board(on: readonly string[] = []): BoardApi {
  const inner = fakeBoard();
  return {
    ...inner,
    cards: async query => (await inner.cards(query)).map(card => ({ ...card, origin: 'agent' as const })),
    switchOf: async project => ({
      projectId: project as never,
      on: on.includes(project),
      setBy: 'default',
      setAt: null,
    }),
  };
}

async function setup(boardApi: BoardApi | undefined = board()) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ME });
  ferrets.add({ id: OTHER, parent: ME, state: 'working' });
  const asks = new FakeAsks();
  const service = new TidyService({ ferrets, asks, board: () => boardApi });
  const makeCard = async (by: typeof ME | 'owner', title: string, assignee: typeof ME | null = null) => {
    const made = await (boardApi as BoardApi).create(by, {
      kind: 'feature',
      title,
      summary: '',
      ask: { text: 'do it', source: 'test' },
      premise: '',
      context: '',
      terms: [],
      brief: '',
      howToTest: '',
      workflow: 'quick',
      parent: null,
      assignee,
      dependsOn: [],
      files: [],
      docs: [],
    });
    if (!made.ok) throw new Error(made.error.message);
    return made.value;
  };
  return { ferrets, asks, service, makeCard };
}

describe('TidyService.plan', () => {
  test('drops the ferret’s own agent-asked card on a board that is off, and the plan parses as the wire', async () => {
    const { service, makeCard } = await setup();
    const card = await makeCard(ME, 'Try a thing');
    const result = await service.plan(ME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.drop.map(d => d.id)).toEqual([card.id]);
    expect(TidyPlanSchema.safeParse(result.plan).success).toBe(true);
  });

  test('keeps a card whose board the switch says is on', async () => {
    const { service, makeCard } = await setup(board(['unfiled']));
    await makeCard(ME, 'Wanted');
    const result = await service.plan(ME);
    expect(result.ok && result.plan.keep.map(k => k.code)).toEqual(['board-on']);
  });

  test('leaves out the cards of other ferrets', async () => {
    const { service, makeCard } = await setup();
    await makeCard(OTHER, 'Not mine');
    const result = await service.plan(ME);
    expect(result.ok && [result.plan.drop, result.plan.keep]).toEqual([[], []]);
  });

  test('keeps a card a working ferret is assigned to, and drops it once that ferret has stopped', async () => {
    const base = board();
    const { makeCard, ferrets } = await setup(base);
    const card = await makeCard(ME, 'Handed over');
    // the fake board keeps assignee null: hand it over through a board that reports the assignee
    const handed: BoardApi = {
      ...base,
      cards: async query => (await base.cards(query)).map(each => ({ ...each, assignee: OTHER })),
    };
    const live = await new TidyService({ ferrets, asks: new FakeAsks(), board: () => handed }).plan(ME);
    expect(live.ok && live.plan.keep.map(k => k.code)).toEqual(['assigned-to-live-ferret']);
    ferrets.setState(OTHER, 'stopped');
    const gone = await new TidyService({ ferrets, asks: new FakeAsks(), board: () => handed }).plan(ME);
    expect(gone.ok && gone.plan.drop.map(d => d.id)).toEqual([card.id]);
  });

  test('keeps a card an open gate ask names', async () => {
    const { service, makeCard, asks } = await setup();
    const card = await makeCard(ME, 'Gated');
    await asks.raise({
      source: sourceKey('card'),
      ref: {},
      ferret: ME,
      entry: entryId(`${card.id}:gate`),
      kind: 'yesno',
      subject: 'Merge?',
      why: 'ready',
      raisedBy: { kind: 'daemon' },
    });
    const result = await service.plan(ME);
    expect(result.ok && result.plan.keep.map(k => k.code)).toEqual(['waiting-at-gate', 'gate']);
  });

  test('plans the ferret’s own asks: a task closes, a question stays', async () => {
    const { service, asks } = await setup();
    const raise = (entry: string, kind: 'task' | 'yesno') =>
      asks.raise({
        source: sourceKey('ferret'),
        ref: {},
        entry: entryId(entry),
        kind,
        subject: entry,
        why: 'w',
        raisedBy: { kind: 'ferret', ferret: ME },
        ferret: ME,
      });
    await raise('track', 'task');
    await raise('question', 'yesno');
    const result = await service.plan(ME);
    expect(result.ok && result.plan.close.map(c => c.subject)).toEqual(['track']);
    expect(result.ok && result.plan.keep.map(k => k.code)).toEqual(['needs-owner']);
  });

  test('leaves the cards out of a helper’s plan', async () => {
    const { service, makeCard } = await setup();
    await makeCard(OTHER, 'Helper card');
    const result = await service.plan(OTHER);
    expect(result.ok && [result.plan.helper, result.plan.drop]).toEqual([true, []]);
  });

  test('says so when the board is off', async () => {
    const { service } = await setup();
    const none = new TidyService({ ferrets: new FakeFerrets(), asks: new FakeAsks(), board: () => undefined });
    expect(await none.plan(ME)).toEqual({
      ok: false,
      message: 'the board is not running, so there is no card to read',
    });
    expect(service).toBeDefined();
  });

  test('says so when the asks cannot be read', async () => {
    const asks = new FakeAsks();
    asks.open = async () => {
      throw new Error('asks are damaged');
    };
    const result = await new TidyService({ ferrets: new FakeFerrets(), asks, board: () => board() }).plan(ME);
    expect(result).toEqual({ ok: false, message: 'asks are damaged' });
  });
});
