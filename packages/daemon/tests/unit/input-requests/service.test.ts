import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputEvent,
  type InputRaise,
  type InputTargetFacts,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import { digestFacts } from '../../../src/lib/input-requests/digest.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputRequestError } from '../../../src/lib/input-requests/errors.ts';
import type {
  InputAuditEntry,
  InputCaller,
  InputCard,
  ObserveResult,
  TypeResult,
} from '../../../src/lib/input-requests/ports.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';

const SESSION = 'mvv6b4qw-49d0158d';
const VALUE = 'hunter2-UNIQUE';
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const DEVICE: InputCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'phone-1' }, carrier: 'relay' };
const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };

const FACTS: InputTargetFacts = {
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
  recognisedConsumer: true,
};

const RAISE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
};

interface World {
  now: number;
  facts: InputTargetFacts | undefined;
  observeReason: 'target_gone' | 'unsupported';
  typeResult: TypeResult;
  cardOk: boolean;
  nextCard: number;
  trusted: Set<string>;
  sessions: string[];
  history: InputEvent[];
  writes: { text: string; submit: boolean }[];
  observes: number;
  cards: InputCard[];
  closed: { id: AgendaId; note: string }[];
  told: { id: AgendaId; message: string }[];
  audits: InputAuditEntry[];
  events: InputEvent[];
  prompt: string | undefined;
  sleeps: (() => void)[];
  nextId: number;
  gate: Promise<void> | undefined;
  observeGate: Promise<void> | undefined;
}

function build(overrides: Partial<World> = {}) {
  const w: World = {
    now: Date.parse('2026-10-30T12:00:00.000Z'),
    facts: FACTS,
    observeReason: 'target_gone',
    typeResult: 'typed',
    cardOk: true,
    nextCard: 1,
    trusted: new Set(),
    sessions: [SESSION],
    history: [],
    writes: [],
    observes: 0,
    cards: [],
    closed: [],
    told: [],
    audits: [],
    events: [],
    prompt: 'sudo wants your password',
    sleeps: [],
    nextId: 1,
    gate: undefined,
    observeGate: undefined,
    ...overrides,
  };
  const clock = { now: () => w.now };
  const values = new EphemeralValues(clock);
  const service = new InputRequestService({
    target: {
      observe: async (): Promise<ObserveResult> => {
        w.observes += 1;
        await w.observeGate;
        return w.facts === undefined ? { ok: false, reason: w.observeReason } : { ok: true, facts: w.facts };
      },
      type: async (_session, _target, text, submit) => {
        w.writes.push({ text, submit });
        await w.gate;
        return w.typeResult;
      },
    },
    agenda: {
      raise: async (_session, card) => {
        if (!w.cardOk) return { ok: false, message: 'the board is full' };
        w.cards.push(card);
        return { ok: true, id: `A${w.nextCard++}` as AgendaId };
      },
      close: async (_session, id, note) => void w.closed.push({ id, note }),
      promptOf: async () => w.prompt,
    },
    notifier: { tell: async (_session, id, message) => void w.told.push({ id, message }) },
    journal: {
      publish: async (_session, event) => void w.events.push(event),
      history: async () => w.history,
    },
    audit: { record: async entry => void w.audits.push(entry) },
    clock,
    ids: { requestId: () => (w.nextId++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(resolve => w.sleeps.push(resolve)) },
    trusted: {
      isTrusted: comm => w.trusted.has(comm),
      trust: comm => void w.trusted.add(comm),
    },
    sessions: { has: async id => w.sessions.includes(id), all: async () => w.sessions },
    values,
  });
  return { w, service, values };
}

const bodyFor = (digest: string, over: Partial<InputDeliverBody> = {}, value = VALUE): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  padded: padInputValue(value),
  submit: true,
  ...over,
});

async function raised(over: Partial<World> = {}, raise: InputRaise = RAISE) {
  const built = build(over);
  const view = await built.service.raise(SESSION, raise);
  const [request] = await built.service.list(HOST);
  if (request === undefined) throw new Error('no request');
  return { ...built, view, request, id: request.id, digest: request.observedDigest ?? '' };
}

const refused = async (promise: Promise<unknown>): Promise<InputRequestError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InputRequestError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('InputRequestService.raise', () => {
  it('should raise a card from what the daemon observed and tell the agent only where it stands', async () => {
    const { w, view, request } = await raised();

    should(view).eql({
      id: 'A1',
      state: 'pending',
      observed: { consumer: 'sudo', echo: 'off', recognised: true },
      note: 'Waiting for the owner on A1.',
    });
    should(w.cards[0]?.title).equal('Needs a secret');
    should(w.cards[0]?.ask).equal('Type it into sudo');
    should(w.cards[0]?.blocking).be.true();
    should(request.expiresAt).equal('2026-10-30T12:10:00.000Z');
    should(w.events[0]?.type).equal('surface.input_requested');
    should(w.audits[0]?.event).equal('input.requested');
    should(w.audits[0]?.detail.consumer).equal('sudo');
  });

  it('should title a code and an answer plainly and honour blocking, chain and expiry', async () => {
    const built = build();
    await built.service.raise(SESSION, { ...RAISE, sensitivity: 'private', blocking: false, expiresInSeconds: 60 });
    await built.service.raise(SESSION, {
      ...RAISE,
      target: { kind: 'terminal', key: 'other' },
      sensitivity: 'plain',
      chain: 'A1' as AgendaId,
    });

    should(built.w.cards.map(card => card.title)).eql(['Needs a code', 'Needs an answer']);
    should(built.w.cards[0]?.blocking).be.false();
    should(built.w.cards[0]?.expiresAt).equal('2026-10-30T12:01:00.000Z');
    should(built.w.cards[1]?.chain).equal('A1');
  });

  it('should refuse a browser target for now', async () => {
    const { service } = build();
    const error = await refused(
      service.raise(SESSION, { ...RAISE, target: { kind: 'browser', key: 'app', selector: '#pw' } }),
    );

    should(error.code).equal('bad_request');
  });

  it('should say a missing terminal is missing and an unsupported target is unsupported', async () => {
    const gone = await refused(build({ facts: undefined }).service.raise(SESSION, RAISE));
    const odd = await refused(build({ facts: undefined, observeReason: 'unsupported' }).service.raise(SESSION, RAISE));

    should(gone.code).equal('not_found');
    should(odd.code).equal('bad_request');
  });

  it('should surface a board that cannot take the card', async () => {
    const error = await refused(build({ cardOk: false }).service.raise(SESSION, RAISE));

    should(error.code).equal('unavailable');
    should(error.message).equal('the board is full');
  });

  it('should refuse a second request on the same terminal', async () => {
    const { service } = await raised();
    const error = await refused(service.raise(SESSION, RAISE));

    should(error.code).equal('conflict');
  });

  it('should hold three pending per session', async () => {
    const { service } = build();
    for (const key of ['a', 'b', 'c']) await service.raise(SESSION, { ...RAISE, target: { kind: 'terminal', key } });
    const error = await refused(service.raise(SESSION, { ...RAISE, target: { kind: 'terminal', key: 'd' } }));

    should(error.code).equal('capacity');
    should(error.reason).equal('rate_limited');
  });

  it('should allow twenty raises an hour and then wait for the hour to pass', async () => {
    const { w, service } = build();
    for (let n = 0; n < 20; n += 1) {
      const view = await service.raise(SESSION, RAISE);
      await service.cancel(SESSION, (await findId(service, view.id)) ?? '', AGENT);
    }
    const error = await refused(service.raise(SESSION, RAISE));
    w.now += 3_600_001;
    const again = await service.raise(SESSION, RAISE);

    should(error.reason).equal('rate_limited');
    should(again.state).equal('pending');
  });
});

async function findId(service: InputRequestService, card: AgendaId): Promise<string | undefined> {
  const open = await service.list(HOST);
  return open.find(request => request.agendaItemId === card)?.id;
}

describe('InputRequestService.deliver', () => {
  it('should type the value once, tell the agent, close the card and press Enter when asked', async () => {
    const { w, service, id, digest } = await raised();
    const result = await service.deliver(SESSION, id, bodyFor(digest), HOST);

    should(result).eql({ id, deliveryId: result.deliveryId, state: 'delivered', submitted: true });
    should(w.writes).eql([{ text: VALUE, submit: true }]);
    should(w.closed[0]?.id).equal('A1');
    should(w.told[0]?.message).containEql('typed into %terminal:dev');
    should(w.events.at(-1)?.type).equal('surface.input_delivered');
    should(w.audits.at(-1)?.event).equal('input.delivered');
    should(w.audits.at(-1)?.actor).eql({ kind: 'host' });
    should((await service.list(HOST)).length).equal(0);
  });

  it('should not press Enter when the agent said it will', async () => {
    const { w, service, id, digest } = await raised({}, { ...RAISE, submit: 'agent' });
    const result = await service.deliver(SESSION, id, bodyFor(digest), DEVICE);

    should(result.submitted).be.false();
    should(w.writes[0]?.submit).be.false();
    should(w.audits.at(-1)?.actor).eql({ kind: 'device', deviceId: 'phone-1' });
  });

  it('should refuse an agent and write nothing', async () => {
    const { w, service, id, digest } = await raised();
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), AGENT));

    should(error.code).equal('forbidden');
    should(w.writes.length).equal(0);
  });

  it('should answer a retry of a deliveryId with the first outcome and never type twice', async () => {
    const { w, service, id, digest } = await raised();
    const body = bodyFor(digest);
    const first = await service.deliver(SESSION, id, body, HOST);
    const again = await service.deliver(SESSION, id, body, HOST);
    const other = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(again).eql(first);
    should(w.writes.length).equal(1);
    should(other.reason).equal('already_delivered');
  });

  it('should answer a retry of a refused delivery with the same refusal and still not type', async () => {
    const { w, service, id } = await raised();
    const body = bodyFor('b'.repeat(64));
    const first = await refused(service.deliver(SESSION, id, body, HOST));
    const again = await refused(service.deliver(SESSION, id, body, HOST));

    should(again).equal(first);
    should(w.writes.length).equal(0);
  });

  it('should refuse a second delivery while the first is typing, and answer a same-id retry with the first', async () => {
    const { w, service, id, digest } = await raised();
    let release: () => void = () => undefined;
    w.gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const body = bodyFor(digest);
    const first = service.deliver(SESSION, id, body, HOST);
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    const retry = service.deliver(SESSION, id, body, HOST);
    const cancel = await refused(service.cancel(SESSION, id, HOST));
    release();

    should(second.reason).equal('already_delivered');
    should(cancel.reason).equal('already_delivered');
    should(await retry).eql(await first);
    should(w.writes.length).equal(1);
  });

  it('should refuse a digest the card did not show: target_changed, zero writes', async () => {
    const { w, service, id } = await raised();
    const error = await refused(service.deliver(SESSION, id, bodyFor('c'.repeat(64)), HOST));

    should(error.code).equal('conflict');
    should(error.reason).equal('target_changed');
    should(w.writes.length).equal(0);
  });

  const mutations: readonly [string, (facts: InputTargetFacts & { kind: 'terminal' }) => InputTargetFacts][] = [
    ['pane', f => ({ ...f, paneProof: { ...f.paneProof, paneId: '%9' } })],
    ['pane pid', f => ({ ...f, paneProof: { ...f.paneProof, pid: 1 } })],
    ['foreground', f => ({ ...f, foreground: { ...f.foreground, pid: 9999 } })],
    ['program', f => ({ ...f, foreground: { ...f.foreground, comm: 'bash' } })],
    ['echo', f => ({ ...f, echo: 'on' })],
    ['cursor row', f => ({ ...f, cursorRow: 7 })],
    ['prompt line', f => ({ ...f, promptLineDigest: 'f'.repeat(64) })],
  ];
  for (const [name, mutate] of mutations) {
    it(`should refuse with target_changed and write nothing when the ${name} changed`, async () => {
      const { w, service, id, digest } = await raised();
      w.facts = mutate(FACTS as InputTargetFacts & { kind: 'terminal' });
      const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

      should(error.reason).equal('target_changed');
      should(w.writes.length).equal(0);
      should((await service.list(HOST)).length).equal(1);
    });
  }

  it('should refuse when the terminal is gone', async () => {
    const { w, service, id, digest } = await raised();
    w.facts = undefined;
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(error.reason).equal('target_changed');
    should(w.writes.length).equal(0);
  });

  it('should refuse when the pane vanishes between the check and the write', async () => {
    const { w, service, id, digest } = await raised();
    w.typeResult = 'target_gone';
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(error.reason).equal('target_changed');
    should((await service.list(HOST)).length).equal(1);
  });

  it('should end the request after three failed checks', async () => {
    const { w, service, id, digest } = await raised();
    for (let n = 0; n < 3; n += 1) await refused(service.deliver(SESSION, id, bodyFor('d'.repeat(64)), HOST));
    const after = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(after.code).equal('gone');
    should(w.events.at(-1)?.type).equal('surface.input_refused');
    should(w.audits.at(-1)?.detail.reason).equal('check_failures');
    should(w.told.at(-1)?.message).containEql('check failures');
    should(w.writes.length).equal(0);
  });

  it('should record each failed check without ending the request', async () => {
    const { w, service, id } = await raised();
    await refused(service.deliver(SESSION, id, bodyFor('d'.repeat(64)), HOST));

    should(w.audits.at(-1)?.event).equal('input.refused');
    should(w.audits.at(-1)?.detail.reason).equal('target_changed');
  });

  it('should refuse a secret when echo is on or cannot be told', async () => {
    for (const echo of ['on', 'unknown'] as const) {
      const on: InputTargetFacts = { ...FACTS, echo };
      const { service, id, digest, w } = await raised({ facts: on });
      const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

      should(error.reason).equal('echo_on');
      should(w.writes.length).equal(0);
    }
  });

  it('should type a private code even with echo on', async () => {
    const on: InputTargetFacts = { ...FACTS, echo: 'on' };
    const { service, id, digest, w } = await raised({ facts: on }, { ...RAISE, sensitivity: 'private' });
    await service.deliver(SESSION, id, bodyFor(digest, {}, '123456'), HOST);

    should(w.writes[0]?.text).equal('123456');
  });

  it('should ask the owner to trust an unrecognised program once', async () => {
    const odd: InputTargetFacts = {
      ...FACTS,
      recognisedConsumer: false,
      foreground: { ...FACTS.foreground, comm: 'myapp' },
    } as InputTargetFacts;
    const { w, service, id, digest } = await raised({ facts: odd });
    const blocked = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    const ok = await service.deliver(SESSION, id, bodyFor(digest, { trustProgram: true }), HOST);

    should(blocked.reason).equal('trust_required');
    should(ok.state).equal('delivered');
    should(w.trusted.has('myapp')).be.true();
    should(w.writes.length).equal(1);
  });

  it('should not ask again for a program the owner trusts, nor for plain text', async () => {
    const odd: InputTargetFacts = {
      ...FACTS,
      recognisedConsumer: false,
      foreground: { ...FACTS.foreground, comm: 'myapp' },
    } as InputTargetFacts;
    const trusted = await raised({ facts: odd, trusted: new Set(['myapp']) });
    const plain = await raised({ facts: odd }, { ...RAISE, sensitivity: 'plain' });

    await trusted.service.deliver(SESSION, trusted.id, bodyFor(trusted.digest), HOST);
    await plain.service.deliver(SESSION, plain.id, bodyFor(plain.digest, {}, 'y'), HOST);
    should(trusted.w.writes.length).equal(1);
    should(plain.w.writes.length).equal(1);
  });

  it('should refuse a value with control characters or a newline for a secret, and a bad shape for any', async () => {
    const { w, service, id, digest } = await raised();
    const enter = await refused(service.deliver(SESSION, id, bodyFor(digest, {}, 'pass\nrm -rf'), HOST));
    const shape = await refused(service.deliver(SESSION, id, bodyFor(digest, { padded: 'hunter2' }), HOST));
    const saved = await refused(
      service.deliver(SESSION, id, bodyFor(digest, { padded: undefined, secretName: 'deploy-key' as never }), HOST),
    );

    should(enter.code).equal('bad_request');
    should(shape.code).equal('bad_request');
    should(saved.code).equal('bad_request');
    should(w.writes.length).equal(0);
    should((await service.list(HOST)).length).equal(1);
  });

  it('should refuse an unknown request and another session', async () => {
    const { service, id, digest } = await raised();
    const missing = await refused(service.deliver(SESSION, 'f'.repeat(32), bodyFor(digest), HOST));
    const other = await refused(service.deliver('mvgt2oz9-04e28935', id, bodyFor(digest), HOST));

    should(missing.code).equal('not_found');
    should(other.code).equal('not_found');
  });

  it('should refuse an expired request as gone', async () => {
    const { w, service, id, digest } = await raised();
    w.now += 601_000;
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(error.code).equal('gone');
    should(w.events.at(-1)?.type).equal('surface.input_expired');
  });
});

describe('the value never leaves the one write', () => {
  it('should put the value nowhere but the terminal write and the ephemeral map', async () => {
    const { w, service, values, view, id, digest } = await raised();
    const seen: unknown[] = [view];
    const result = await service.deliver(SESSION, id, bodyFor(digest), HOST);
    seen.push(
      result,
      await service.agentView(SESSION, 'A1' as AgendaId, 0),
      await service.list(HOST),
      w.cards,
      w.closed,
      w.told,
      w.audits,
      w.events,
    );
    const denied = await refused(service.deliver(SESSION, id, bodyFor(digest), AGENT));
    seen.push(denied.message);
    const echoed = `login: ok\n${VALUE}\n`;

    should(JSON.stringify(seen)).not.containEql(VALUE);
    should(w.writes).eql([{ text: VALUE, submit: true }]);
    should(values.scrub(SESSION, echoed)).equal('login: ok\n[redacted:input A1]\n');
    should(values.scrub('another-session', echoed)).equal(echoed);
  });

  it('should keep the value out of every refusal message too', async () => {
    const { service, id } = await raised();
    const errors = [
      await refused(service.deliver(SESSION, id, bodyFor('c'.repeat(64)), HOST)),
      await refused(service.deliver(SESSION, id, bodyFor('c'.repeat(64), {}, `${VALUE}\n`), HOST)),
    ];

    should(errors.map(error => error.message).join(' ')).not.containEql('hunter2');
  });

  it('should mask the value from reads for the window and no longer', async () => {
    const { w, service, values, id, digest } = await raised();
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    w.now += 599_000;
    should(values.scrub(SESSION, VALUE)).equal('[redacted:input A1]');
    w.now += 2_000;
    should(values.scrub(SESSION, VALUE)).equal(VALUE);
  });
});

describe('InputRequestService.cancel, expire, wait and restore', () => {
  it('should cancel for the owner, tell the agent, and refuse a cancel after the end', async () => {
    const { w, service, id } = await raised();
    const request = await service.cancel(SESSION, id, HOST);
    const again = await refused(service.cancel(SESSION, id, HOST));

    should(request.state).equal('cancelled');
    should(w.told[0]?.message).containEql('owner declined');
    should(w.closed.length).equal(1);
    should(again.code).equal('gone');
  });

  it('should let the raising agent withdraw without telling itself', async () => {
    const { w, service, id } = await raised();
    await service.cancel(SESSION, id, AGENT);

    should(w.told.length).equal(0);
    should(w.audits.at(-1)?.detail.reason).equal('agent_cancelled');
  });

  it('should refuse another session’s agent and an unknown request', async () => {
    const { service, id } = await raised();
    const other = await refused(service.cancel(SESSION, id, { kind: 'agent', sessionId: 'x-1' }));
    const missing = await refused(service.cancel(SESSION, 'e'.repeat(32), HOST));
    const wrong = await refused(service.cancel('x-1', id, HOST));

    should(other.code).equal('forbidden');
    should(missing.code).equal('not_found');
    should(wrong.code).equal('not_found');
  });

  it('should end a request when its card is dismissed, once', async () => {
    const { w, service } = await raised();
    await service.cardDismissed(SESSION, 'A1' as AgendaId);
    await service.cardDismissed(SESSION, 'A1' as AgendaId);
    await service.cardDismissed(SESSION, 'A9' as AgendaId);

    should(w.closed.length).equal(0);
    should(w.told.length).equal(1);
    should(w.events.at(-1)?.type).equal('surface.input_cancelled');
  });

  it('should expire a pending request at its time and tell the agent', async () => {
    const { w, service } = await raised();
    w.now += 600_000;
    await service.sweep();

    should(w.events.at(-1)?.type).equal('surface.input_expired');
    should(w.closed.length).equal(1);
    should(w.told[0]?.message).containEql('expired');
    should((await service.agentView(SESSION, 'A1' as AgendaId, 0)).state).equal('expired');
  });

  it('should find what is pending on a terminal and nothing after the end', async () => {
    const { service, id } = await raised();

    should(service.pendingOn(SESSION, { kind: 'terminal', key: 'dev' })).equal('A1');
    should(service.pendingOn(SESSION, { kind: 'terminal', key: 'other' })).be.undefined();
    should(service.pendingOn('x-1', { kind: 'terminal', key: 'dev' })).be.undefined();
    await service.cancel(SESSION, id, HOST);
    should(service.pendingOn(SESSION, { kind: 'terminal', key: 'dev' })).be.undefined();
  });

  it('should mask a delivered value from an agent read for the redaction window', async () => {
    const { service, id, digest } = await raised();
    await service.deliver(SESSION, id, bodyFor(digest), HOST);

    should(service.scrub(SESSION, `echoed ${VALUE}`)).equal('echoed [redacted:input A1]');
    should(service.scrub('other-1', VALUE)).equal(VALUE);
  });

  it('should let the agent wait for the answer and wake as soon as it comes', async () => {
    const { w, service, id, digest } = await raised();
    const waiting = service.agentView(SESSION, 'A1' as AgendaId, 5_000);
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    const view = await waiting;

    should(view.state).equal('delivered');
    should(view.submitted).be.true();
    should(view.source).equal('typed');
    should(w.sleeps.length).equal(1);
  });

  it('should return the pending view when the wait runs out', async () => {
    const { w, service } = await raised();
    const waiting = service.agentView(SESSION, 'A1' as AgendaId, 5_000);
    await Promise.resolve();
    w.sleeps[0]?.();

    should((await waiting).state).equal('pending');
  });

  it('should say an agent has no such request', async () => {
    const { service } = await raised();
    const error = await refused(service.agentView(SESSION, 'A9' as AgendaId, 0));
    const wrong = await refused(service.agentView('x-1', 'A1' as AgendaId, 0));

    should(error.code).equal('not_found');
    should(wrong.code).equal('not_found');
  });

  it('should list only the owner’s view, for one session or all', async () => {
    const { service } = await raised();
    const denied = await refused(service.list(AGENT));

    should(denied.code).equal('forbidden');
    should((await service.list(HOST, SESSION)).length).equal(1);
    should((await service.list(HOST, 'x-1')).length).equal(0);
  });

  it('should bring a pending request back after a restart and re-observe before Send is allowed', async () => {
    const first = await raised();
    const history = first.w.events;
    const second = build({ history: [...history] });
    await second.service.restore();
    const [back] = await second.service.list(HOST);

    should(back?.prompt).equal('sudo wants your password');
    should(back?.state).equal('pending');
    should(back?.observed).eql(FACTS);
    should(back?.observedDigest).equal(digestFacts(FACTS));
    should(second.w.cards.length).equal(0);
    await second.service.deliver(SESSION, back?.id ?? '', bodyFor(back?.observedDigest ?? ''), HOST);
    should(second.w.writes.length).equal(1);
  });

  it('should disable Send while a restored request is still being looked at again', async () => {
    const first = await raised();
    let release: () => void = () => undefined;
    const second = build({
      history: [...first.w.events],
      observeGate: new Promise<void>(resolve => {
        release = resolve;
      }),
    });
    const restoring = second.service.restore();
    await new Promise(resolve => setTimeout(resolve, 0));
    const [back] = await second.service.list(HOST);
    const view = await second.service.agentView(SESSION, 'A1' as AgendaId, 0);
    const error = await refused(second.service.deliver(SESSION, back?.id ?? '', bodyFor('a'.repeat(64)), HOST));
    release();
    await restoring;

    should(back?.observed).be.undefined();
    should(view).eql({ id: 'A1', state: 'pending', note: 'Waiting for the owner on A1.' });
    should(error.code).equal('unavailable');
  });

  it('should cancel a restored request whose terminal is gone, and skip ended, expired and promptless ones', async () => {
    const first = await raised();
    const requested = first.w.events[0];
    if (requested === undefined) throw new Error('no event');
    const gone = build({ history: [requested], facts: undefined });
    await gone.service.restore();

    should(gone.w.events.at(-1)?.type).equal('surface.input_cancelled');
    should(gone.w.told.at(-1)?.message).containEql('interrupted');
    should((await gone.service.list(HOST)).length).equal(0);

    const ended = build({ history: [requested, { ...requested, type: 'surface.input_delivered' }] });
    const late = build({ history: [{ ...requested, expiresAt: '2026-10-30T11:00:00.000Z' }] });
    const promptless = build({ history: [requested], prompt: undefined });
    const browser = build({ history: [{ ...requested, target: { kind: 'browser', key: 'app' } }] });
    const foreign = build({ history: [{ ...requested, sessionId: 'x-1' }] });
    for (const world of [ended, late, promptless, browser, foreign]) {
      await world.service.restore();
      should((await world.service.list(HOST)).length).equal(0);
    }
    const twice = build({ history: [requested, requested] });
    await twice.service.restore();
    await twice.service.restore();
    should((await twice.service.list(HOST)).length).equal(1);
  });
});
