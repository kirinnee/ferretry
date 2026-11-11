import { afterEach, describe, expect, it } from 'bun:test';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import type { AgendaBoardContext, AgendaFerretsContext } from '../../../contract/index.ts';
import { asksHalf, EVERY_FERRET } from '../../support/daemon/asks-half.ts';

const BOARD = 'POST /v1/ferrets/:ferretId/agenda';
const LIST = 'GET /v1/ferrets/:ferretId/agenda';
const LEAD = { ferretId: 'lead' };
const CHILD = { ferretId: 'child' };
const as = (id: string) => ferretStanding(id as FerretId);

const halves: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(halves.splice(0).map(async half => await half.close()));
});
const world = async (providers: Record<string, unknown> = {}) => {
  const half = await asksHalf(providers);
  halves.push(half);
  return half;
};

/** `child` was started by `lead`. */
const lineage: AgendaFerretsContext = {
  ...EVERY_FERRET,
  leadOf: async id => (id === 'child' ? 'lead' : undefined),
  addressOf: async id => (id === 'lead' ? 'lizzette' : id),
};
const board = (over: Partial<AgendaBoardContext> = {}): AgendaBoardContext => ({
  focusOf: async id => (id === 'lead' ? { id: 'F12' } : null),
  inToTest: async () => false,
  asking: async () => undefined,
  ...over,
});
const add = (extra: Record<string, unknown> = {}) => ({
  action: 'add',
  title: 'Release unblock',
  subject: 'Ship it?',
  why: 'The release is ready.',
  premise: 'A ferret needs the owner.',
  context: 'The work waits on this answer.',
  howToResolve: 'Answer yes or no.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
  ...extra,
});
const items = async (half: Awaited<ReturnType<typeof world>>, ferret = LEAD) =>
  (await half.call(LIST, ferret, undefined, as(ferret.ferretId))).json<{ items: { task?: { id: string } }[] }>().items;

describe('R-0333 M3 the agenda knows who started whom, and which card a ferret works on', () => {
  it('refuses a sub-ferret’s add with the sentence that says whom to tell', async () => {
    const half = await world({ 'agenda.context:ferrets': lineage, 'agenda.context:board': board() });
    const refused = await half.call(BOARD, CHILD, add(), as('child'));
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('You are a sub-ferret');
    expect(refused.body).toContain('fy send lizzette');
    expect(await items(half, CHILD)).toHaveLength(0);
  });

  it('refuses an add when the lineage cannot be read, never reading "nobody started it" as "a lead"', async () => {
    const down: AgendaFerretsContext = { ...EVERY_FERRET, leadOf: async () => Promise.reject(new Error('down')) };
    const half = await world({ 'agenda.context:ferrets': down });
    const refused = await half.call(BOARD, LEAD, add(), as('lead'));
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('cannot be read');
    expect(await items(half)).toHaveLength(0);
  });

  it('accepts a lead’s add and ties it to the lead’s focus card', async () => {
    const half = await world({ 'agenda.context:ferrets': lineage, 'agenda.context:board': board() });
    const added = await half.call(BOARD, LEAD, add(), as('lead'));
    expect(added.status).toBe(200);
    expect((await items(half))[0]?.task).toMatchObject({ id: 'F12' });
  });

  it('refuses a second ask about a card whose gate already asks, and says where the card’s ask is', async () => {
    const half = await world({
      'agenda.context:ferrets': lineage,
      'agenda.context:board': board({ asking: async () => ({ sessionId: 'lead', id: 'A7' as never }) }),
    });
    const refused = await half.call(BOARD, LEAD, add({ task: { id: 'F12' } }), as('lead'));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body).toContain('already asks the owner on !A7');
  });

  it('with Board off, an add keeps only the card it names and a gate it cannot read is asking', async () => {
    const half = await world({ 'agenda.context:ferrets': lineage });
    const added = await half.call(BOARD, LEAD, add({ task: { id: 'F12' } }), as('lead'));
    expect(added.status).toBe(200);
    expect(added.body).toContain('gate could not be read');
    expect((await items(half))[0]?.task).toBeUndefined();
  });

  describe('a to-do on a card in the to-test lane offers to close it, as far as Board can say so', () => {
    const todo = () => add({ kind: 'task', ask: { kind: 'task' }, task: { id: 'F12' } });
    const offered = async (providers: Record<string, unknown>) => {
      const half = await world(providers);
      const added = await half.call(BOARD, LEAD, todo(), as('lead'));
      expect(added.status).toBe(200);
      return (await items(half)).map(item => (item as { offerClose?: boolean }).offerClose);
    };

    it('offers when Board says the card is in the to-test lane', async () => {
      expect(
        await offered({
          'agenda.context:ferrets': lineage,
          'agenda.context:board': board({ inToTest: async () => true }),
        }),
      ).toEqual([true]);
    });

    it('does not offer when Board says it is elsewhere, cannot say, or is off', async () => {
      expect(await offered({ 'agenda.context:ferrets': lineage, 'agenda.context:board': board() })).toEqual([
        undefined,
      ]);
      expect(
        await offered({
          'agenda.context:ferrets': lineage,
          'agenda.context:board': board({ inToTest: async () => Promise.reject(new Error('board unreadable')) }),
        }),
      ).toEqual([undefined]);
      expect(await offered({ 'agenda.context:ferrets': lineage })).toEqual([undefined]);
    });
  });

  it('with Ferrets off, no ferret has a board and no add is accepted', async () => {
    const half = await world({ 'agenda.context:ferrets': 'unavailable' });
    const refused = await half.call(BOARD, LEAD, add(), as('lead'));
    expect(refused.status).toBe(404);
  });
});
