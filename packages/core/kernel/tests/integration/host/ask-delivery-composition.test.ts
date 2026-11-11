import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsksPort } from '../../../../asks/contract/index.ts';
import { Harnesses, Runners, StartDecide } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * R-0333 M3 + R-0334 V-0032 through the daemon, with NOTHING of the path substituted: the REAL Asks, Ferrets,
 * Conversation and Board halves, as the generated registry builds them. Only the edges are faked: the harness, the
 * runner (the terminal an answer is typed into), the Packs start admission, and the transcript a receipt is proved from.
 * Lineage is Ferrets', focus and gates are Board's, delivery is Conversation's; no test double stands in for any.
 *
 * Fixture values only; no network, no real state.
 */
const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const ASK = {
  action: 'add',
  title: 'Release unblock',
  subject: 'Ship it?',
  why: 'The release is ready.',
  premise: 'A ferret needs the owner.',
  context: 'The work waits on this answer.',
  howToResolve: 'Answer yes or no.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
};
const ANSWER = '[answer to !A1 «Ship it?»] Yes';

type Entry = { id: string; role: string; text: string; at: string };

const world = async () => {
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  const transcript: Entry[] = [];
  harness.transcript.read = async () => transcript as never;
  let standing = ownerStanding();
  const stub = (id: string, hooks: Record<string, unknown>, declared: Parameters<typeof definePlugin>[0]['hooks']) =>
    implementDaemon(
      definePlugin({
        id,
        title: `${id} (stand-in)`,
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        hooks: declared,
      }),
      { build: () => ({ hooks: hooks as never }) },
    );
  const h = await testHost({
    plugins: [
      real('asks'),
      real('ferrets'),
      real('conversation'),
      real('board'),
      stub('packs', { 'start.decide': () => ({ allow: true }) }, { takes: [{ hook: StartDecide }] }),
      stub('claude-code', { 'harnesses:claude-code': harness }, { takes: [{ hook: Harnesses, key: 'claude-code' }] }),
      stub('terminals', { 'runners:tmux': runner }, { takes: [{ hook: Runners, key: 'tmux' }] }),
    ],
    gate: new StandInAdmission(() => standing),
    fakes: { gate: new FakeGate(), vault: new FakeVault() },
  });
  const start = async (body: Record<string, unknown>) => {
    const started = await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': randomUUID() }, body });
    expect(started.status).toBeLessThan(300);
    const { id } = started.json<{ id: string }>();
    await h.settle();
    // `fy send` reaches a ferret by its callsign (the registry's name), else its id: read it from the daemon.
    const listed = (await h.request('GET', `/v1/ferrets/${id}`)).json<{ name?: string }>();
    return { id, address: listed.name ?? id };
  };
  return {
    h,
    runner,
    transcript,
    start,
    as: (who: 'owner' | string) => {
      standing = who === 'owner' ? ownerStanding() : ferretStanding(who as never);
    },
  };
};

const worlds: Awaited<ReturnType<typeof world>>[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(async w => await w.h.stop()));
});
const open = async () => {
  const w = await world();
  worlds.push(w);
  return w;
};

describe('R-0333 M3: lineage, focus and home through the real Ferrets and Board', () => {
  test('a sub-ferret’s add is a 403 naming its lead’s callsign, and creates no item', async () => {
    const w = await open();
    const lead = await w.start({ folder: '/work/lead', prompt: 'Lead the work.' });
    const child = await w.start({ folder: '/work/lead', parent: lead.id, prompt: 'Help the lead.' });

    w.as(child.id);
    const refused = await w.h.request('POST', `/v1/ferrets/${child.id}/agenda`, { body: ASK });

    expect(refused.status).toBe(403);
    expect(refused.body).toContain('You are a sub-ferret');
    expect(refused.body).toContain(`fy send ${lead.address}`);
    const listed = await w.h.request('GET', `/v1/ferrets/${child.id}/agenda`);
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(0);
    expect((await w.h.request('GET', `/v1/ferrets/${lead.id}/agenda`)).json<{ items: unknown[] }>().items).toHaveLength(
      0,
    );
  });

  test('a lead’s add is accepted and carries the card Board says it focuses on', async () => {
    const w = await open();
    const lead = await w.start({ folder: '/work/lead', prompt: 'Lead the work.' });
    const card = await w.h.request('POST', '/v1/board/cards', {
      body: {
        kind: 'feature',
        title: 'Ship release',
        assignee: lead.id,
        howToTest: 'Open the release and check its version.',
        ask: { text: 'Ship the release.', source: 'owner' },
      },
    });
    expect(card.status).toBe(200);
    const cardId = card.json<{ card: { id: string } }>().card.id;
    w.as(lead.id);
    expect((await w.h.request('POST', `/v1/board/cards/${cardId}`, { body: { action: 'focus' } })).status).toBe(200);

    const added = await w.h.request('POST', `/v1/ferrets/${lead.id}/agenda`, { body: ASK });

    expect(added.status).toBe(200);
    expect(added.json<{ items: { task?: { id: string } }[] }>().items[0]?.task?.id).toBe(cardId);
  });

  test('a card in its gate refuses another explicitly card-linked ask and points at the existing one', async () => {
    const w = await open();
    const lead = await w.start({ folder: '/work/lead', prompt: 'Lead the work.' });
    const card = await w.h.request('POST', '/v1/board/cards', {
      body: {
        kind: 'feature',
        title: 'Ship release',
        assignee: lead.id,
        howToTest: 'Open the release and check its version.',
        ask: { text: 'Ship the release.', source: 'owner' },
      },
    });
    const cardId = card.json<{ card: { id: string } }>().card.id;
    for (const to of ['doing', 'to-test'])
      expect(
        (await w.h.request('POST', `/v1/board/cards/${cardId}`, { body: { action: 'move', to, reason: 'Gate check' } }))
          .status,
      ).toBe(200);
    await w.h.settle();
    w.as(lead.id);

    const second = await w.h.request('POST', `/v1/ferrets/${lead.id}/agenda`, {
      body: { ...ASK, title: 'Another release decision', subject: 'Another release decision?', task: { id: cardId } },
    });

    expect(second.status).toBe(400);
    expect(second.body).toContain('already asks the owner');
  });

  test('a standing notice about a sub-ferret lands on its lead, and the returned ref finds it (retry-safe)', async () => {
    const w = await open();
    const lead = await w.start({ folder: '/work/lead', prompt: 'Lead the work.' });
    const child = await w.start({ folder: '/work/lead', parent: lead.id, prompt: 'Help the lead.' });
    const asks = w.h.provided(AsksPort);
    const notice = {
      source: 'daemon' as never,
      ref: {},
      entry: 'helper-blocked' as never,
      subject: 'Helper has blocked work',
      why: 'It waits on a decision.',
      raisedBy: { kind: 'daemon' as const },
      ferret: child.id,
    };

    const ref = await asks.standing(notice);
    const again = await asks.standing(notice);
    const ordinary = await asks.notify({ ...notice, entry: 'helper-finished' as never, subject: 'Helper finished' });

    expect(ref.ferret).toBe(lead.id);
    expect((await asks.get(ref))?.subject).toBe('Helper has blocked work');
    expect(again).toEqual(ref);
    expect(ordinary.ferret).toBe(lead.id);
  });
});

describe('R-0334 V-0032: an owner’s answer reaches the ferret through the real Conversation', () => {
  test('is typed into the runner once, settles to a delivered receipt from the transcript, and clears the outbox', async () => {
    const w = await open();
    const lead = await w.start({ folder: '/work/lead', prompt: 'Lead the work.' });
    w.as(lead.id);
    expect((await w.h.request('POST', `/v1/ferrets/${lead.id}/agenda`, { body: ASK })).status).toBe(200);
    w.as('owner');

    const answered = await w.h.request('POST', `/v1/ferrets/${lead.id}/agenda`, {
      body: { action: 'resolve', id: 'A1', response: { kind: 'multiple-choice', choice: 'Yes' } },
    });
    expect(answered.status).toBe(200);
    expect((await w.h.request('POST', `/v1/ferrets/${lead.id}/agenda/replies`, { body: {} })).status).toBe(200);
    await w.h.settle();

    // The runner types on real I/O turns the fake clock does not drive: wait for the send, bounded.
    const settled = async (until: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await until()); i += 1) {
        await w.h.settle();
        await Bun.sleep(20);
      }
    };
    const sendsOf = async () =>
      (await w.h.request('GET', `/v1/ferrets/${lead.id}/sends`)).json<{
        sends: { sendId: string; message: string; matchText?: string; fate?: string }[];
      }>().sends;
    await settled(async () => (await sendsOf()).length > 0);
    const typed = () => w.runner.deliveries.filter(d => d.delivery.text.includes('[answer to !A1'));
    const sends = await sendsOf();
    expect(sends).toHaveLength(1);
    expect(typed()).toHaveLength(1);
    expect(typed()[0]?.delivery.text).toContain(ANSWER);
    // Until the ferret's transcript shows the words, the owner is told the answer is on its way.
    expect(
      (await w.h.request('GET', `/v1/ferrets/${lead.id}/agenda`)).json<{ delivery?: unknown }>().delivery,
    ).toBeDefined();

    w.transcript.push({
      id: 'u-proof',
      role: 'user',
      text: sends[0]?.matchText ?? sends[0]?.message ?? '',
      at: new Date(w.h.clock.nowMs() + 1000).toISOString(),
    });
    await settled(async () => {
      await w.h.clock.advance(5000);
      return (await sendsOf())[0]?.fate === 'delivered';
    });

    expect(
      (await w.h.request('GET', `/v1/ferrets/${lead.id}/sends`)).json<{ sends: { fate: string }[] }>().sends[0]?.fate,
    ).toBe('delivered');
    expect(
      (await w.h.request('GET', `/v1/ferrets/${lead.id}/agenda`)).json<{ delivery?: unknown }>().delivery,
    ).toBeUndefined();
    // The same send id again types nothing a second time.
    await w.h.request('POST', `/v1/ferrets/${lead.id}/agenda/replies`, { body: {} });
    await w.h.settle();
    expect(typed()).toHaveLength(1);
  });
});
