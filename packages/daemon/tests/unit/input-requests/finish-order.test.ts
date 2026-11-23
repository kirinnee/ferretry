import { describe, it } from 'bun:test';
import { type AgendaId, type InputEvent, padInputValue } from '@ferretry/protocol';
import should from 'should';
import type { InputCaller } from '../../../src/lib/input-requests/ports.ts';
import { inputRequestService, RAISE, SESSION } from './support.ts';

/** The order an answered request ends in (!A607): journal first, then the waiting ferret, then the follow-up work. */

const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>(resolve => (open = resolve));
  return { open, opened };
};
const tick = async (): Promise<void> => await new Promise<void>(resolve => setTimeout(resolve, 5));

const answer = async (world: ReturnType<typeof inputRequestService>) => {
  await world.service.raise(SESSION, { ...RAISE, sensitivity: 'plain' });
  const [request] = await world.service.list(HOST, SESSION);
  const open = request as NonNullable<typeof request>;
  const waiting = world.service.agentView(SESSION, open.agendaItemId, 60_000);
  const delivered = world.service.deliver(
    SESSION,
    open.id,
    { deliveryId: 'd1', padded: padInputValue('yes'), submit: true, observedDigest: open.observedDigest as string },
    HOST,
  );
  return { waiting, delivered, open };
};

describe('an answered request ends journal first', () => {
  it('should not tell the waiting ferret it was delivered before the journal holds the outcome', async () => {
    const hold = gate();
    const world = inputRequestService({
      journalGate: async event => {
        if (event.type === 'surface.input_delivered') await hold.opened;
      },
    });
    const { waiting, delivered } = await answer(world);
    let woke = false;
    void waiting.then(() => {
      woke = true;
    });
    await tick();
    should(woke).be.false();
    should(world.events.some(event => event.type === 'surface.input_delivered')).be.false();

    hold.open();
    const view = await waiting;
    should(view.state).equal('delivered');
    should(world.events.some(event => event.type === 'surface.input_delivered')).be.true();
    await delivered;
  });

  it('should wake the waiting ferret while the audit, card and notice are still slow', async () => {
    const hold = gate();
    const closed: string[] = [];
    const told: string[] = [];
    const world = inputRequestService({
      audited: async entry => {
        if (entry.event === 'input.delivered') await hold.opened;
      },
      told: message => void told.push(message),
      agenda: {
        raise: async () => ({ ok: true, id: 'A1' as AgendaId }),
        close: async (_session, _card, note) => void closed.push(note),
        promptOf: async () => 'sudo wants your password',
      },
    });
    const { waiting, delivered } = await answer(world);
    const view = await waiting;
    should(view.state).equal('delivered');
    should(closed).eql([]);
    should(told).eql([]);

    hold.open();
    await delivered;
    should(closed.length).equal(1);
    should(told.length).equal(1);
    should(world.settled.length).equal(1);
  });

  it('should record what the follow-up work needs in the outcome event, with no value', async () => {
    const world = inputRequestService();
    const { delivered } = await answer(world);
    await delivered;
    const ended = world.events.find(event => event.type === 'surface.input_delivered');
    should(ended?.after).eql({ closeCard: true, tellAgent: true });
    should(JSON.stringify(world.events)).not.containEql('yes');
  });
});

describe('a restart after the outcome was journalled but before its follow-up work', () => {
  const event = (type: InputEvent['type'], after?: InputEvent['after']): InputEvent => ({
    type,
    requestId: '00000000000000000000000000000001',
    agendaItemId: 'A1' as AgendaId,
    sessionId: SESSION,
    target: { kind: 'terminal', key: 'dev' },
    sensitivity: 'plain',
    state: 'delivered',
    ...(after === undefined ? {} : { after }),
    at: '2026-10-30T11:59:00.000Z',
  });

  it('should do the audit, the card and the notice once, and settle', async () => {
    const audited: string[] = [];
    const closed: string[] = [];
    const told: string[] = [];
    const world = inputRequestService({
      history: [event('surface.input_delivered', { closeCard: true, tellAgent: true })],
      audited: entry => void audited.push(entry.event),
      told: message => void told.push(message),
      agenda: {
        raise: async () => ({ ok: true, id: 'A1' as AgendaId }),
        close: async (_session, _card, note) => void closed.push(note),
        promptOf: async () => 'sudo wants your password',
      },
    });
    await world.service.restore();
    should(audited).eql(['input.delivered']);
    should(closed.length).equal(1);
    should(told.length).equal(1);
    should(world.settled.length).equal(1);
  });

  it('should do nothing for an outcome that was settled', async () => {
    const audited: string[] = [];
    const world = inputRequestService({
      history: [event('surface.input_settled', { closeCard: true, tellAgent: true })],
      audited: entry => void audited.push(entry.event),
    });
    await world.service.restore();
    should(audited).eql([]);
    should(world.events).eql([]);
    should(world.settled).eql([]);
  });
});
