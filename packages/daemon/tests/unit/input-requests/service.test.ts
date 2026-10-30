import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputEvent,
  type InputQuarantineEvent,
  type InputRaise,
  type InputTargetFacts,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import { digestFacts, digestLine } from '../../../src/lib/input-requests/digest.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputRequestError } from '../../../src/lib/input-requests/errors.ts';
import type {
  InputAuditEntry,
  InputCaller,
  InputCard,
  ObserveResult,
  TypeResult,
} from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
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
  names: string[] | undefined;
  quarantineEvents: InputQuarantineEvent[];
  quarantineHistory: InputQuarantineEvent[];
  prompt: string | undefined;
  sleeps: (() => void)[];
  nextId: number;
  gate: Promise<void> | undefined;
  observeGate: Promise<void> | undefined;
  failJournal: string | undefined;
  typeThrows: boolean;
  order: string[];
  closeThrows: boolean;
  /** Holds the audit record of a refusal: the failed attempt's side effect, suspended. */
  refusalAuditGate: Promise<void> | undefined;
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
    names: undefined,
    quarantineEvents: [],
    quarantineHistory: [],
    prompt: 'sudo wants your password',
    sleeps: [],
    nextId: 1,
    gate: undefined,
    observeGate: undefined,
    failJournal: undefined,
    typeThrows: false,
    order: [],
    closeThrows: false,
    refusalAuditGate: undefined,
    ...overrides,
  };
  const clock = { now: () => w.now };
  const values = new EphemeralValues(clock);
  const quarantine = new QuarantineRegistry(clock);
  const service = new InputRequestService({
    target: {
      observe: async (): Promise<ObserveResult> => {
        w.observes += 1;
        await w.observeGate;
        return w.facts === undefined
          ? { ok: false, reason: w.observeReason }
          : { ok: true, facts: w.facts, ...(w.names === undefined ? {} : { names: w.names }) };
      },
      type: async (_session, _target, text, submit) => {
        w.order.push('write');
        w.writes.push({ text, submit });
        await w.gate;
        if (w.typeThrows) throw new Error('tmux went away');
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
      publish: async (_session, event) => {
        if (w.failJournal === event.type) throw new Error('the journal is full');
        w.order.push(event.type);
        w.events.push(event);
      },
      history: async () => w.history,
      quarantine: async (_session, event) => void w.quarantineEvents.push(event),
      quarantines: async () => w.quarantineHistory,
    },
    audit: {
      record: async entry => {
        if (entry.event === 'input.refused') await w.refusalAuditGate;
        w.audits.push(entry);
      },
    },
    clock,
    ids: { requestId: () => (w.nextId++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(resolve => w.sleeps.push(resolve)) },
    trusted: {
      isTrusted: comm => w.trusted.has(comm),
      trust: comm => void w.trusted.add(comm),
    },
    sessions: { ended: async id => !w.sessions.includes(id), all: async () => w.sessions },
    values,
    quarantine,
    redact: async text => values.scrubAll(text),
  });
  return { w, service, values, quarantine };
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
    await built.service.raise(SESSION, { ...RAISE, sensitivity: 'plain', blocking: false, expiresInSeconds: 60 });
    await built.service.raise(SESSION, {
      ...RAISE,
      target: { kind: 'terminal', key: 'other' },
      sensitivity: 'plain',
      chain: 'A1' as AgendaId,
    });

    should(built.w.cards.map(card => card.title)).eql(['Needs an answer', 'Needs an answer']);
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
      await service.cancel(SESSION, (await findId(service, view.id)) ?? '', HOST);
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

  it('should queue a second delivery behind the first, then refuse it, and answer a same-id retry with the first', async () => {
    const { w, service, id, digest } = await raised();
    let release: () => void = () => undefined;
    w.gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const body = bodyFor(digest);
    const first = service.deliver(SESSION, id, body, HOST);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    const retry = service.deliver(SESSION, id, body, HOST);
    const cancel = refused(service.cancel(SESSION, id, HOST));
    await new Promise(resolve => setTimeout(resolve, 0));
    should(w.writes.length).equal(1);
    release();

    should((await second).reason).equal('already_delivered');
    should((await cancel).reason).equal('already_delivered');
    should(await retry).eql(await first);
    should(w.writes.length).equal(1);
  });

  it('should type once when two Sends with distinct ids race, even with a slow observation', async () => {
    const { w, service, id, digest } = await raised();
    let open: () => void = () => undefined;
    w.observeGate = new Promise<void>(resolve => {
      open = resolve;
    });
    const results = Promise.allSettled([
      service.deliver(SESSION, id, bodyFor(digest), HOST),
      service.deliver(SESSION, id, bodyFor(digest), HOST),
      service.deliver(SESSION, id, bodyFor(digest), DEVICE),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    open();
    const settled = await results;

    should(w.writes.length).equal(1);
    should(settled.filter(r => r.status === 'fulfilled').length).equal(1);
    for (const r of settled) {
      if (r.status === 'rejected') should((r.reason as InputRequestError).reason).equal('already_delivered');
    }
  });

  it('should type once when a FAILED attempt is still recording its refusal while two later Sends race', async () => {
    // Arrange — the first attempt is refused (a digest the card did not show) and its audit is suspended. If
    // the lock covered only the write, the two correct Sends behind it would both pass their guards and type.
    const { w, service, id, digest } = await raised();
    let record: () => void = () => undefined;
    w.refusalAuditGate = new Promise<void>(resolve => {
      record = resolve;
    });

    // Act
    const failing = service.deliver(SESSION, id, bodyFor('c'.repeat(64)), HOST);
    await new Promise(resolve => setTimeout(resolve, 0));
    const results = Promise.allSettled([
      service.deliver(SESSION, id, bodyFor(digest), HOST),
      service.deliver(SESSION, id, bodyFor(digest), DEVICE),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    should(w.writes.length).equal(0);
    record();
    const settled = await results;
    const refusal = await refused(failing);

    // Assert
    should(refusal.reason).equal('target_changed');
    should(w.writes.length).equal(1);
    should(settled.filter(r => r.status === 'fulfilled').length).equal(1);
    for (const r of settled) {
      if (r.status === 'rejected') should((r.reason as InputRequestError).reason).equal('already_delivered');
    }
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

  it('should refuse a secret at the door when echo is on or cannot be told', async () => {
    for (const echo of ['on', 'unknown'] as const) {
      const built = build({ facts: { ...FACTS, echo } });
      const error = await refused(built.service.raise(SESSION, RAISE));

      should(error.code).equal('conflict');
      should(error.reason).equal('echo_on');
      should(built.w.cards.length).equal(0);
    }
  });

  it('should refuse a secret at delivery when the terminal began echoing after the card was raised', async () => {
    for (const echo of ['on', 'unknown'] as const) {
      const { w, service, id, digest } = await raised();
      w.facts = { ...FACTS, echo };
      const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

      should(error.reason).equal('target_changed');
      should(w.writes.length).equal(0);
    }
  });

  it('should refuse a secret after a restart when the terminal it finds again echoes, matching what the card shows', async () => {
    for (const echo of ['on', 'unknown'] as const) {
      const first = await raised();
      const second = build({ history: [...first.w.events], facts: { ...FACTS, echo } });
      await second.service.restore();
      const [back] = await second.service.list(HOST);
      const error = await refused(
        second.service.deliver(SESSION, back?.id ?? '', bodyFor(back?.observedDigest ?? ''), HOST),
      );

      should(error.code).equal('conflict');
      should(error.reason).equal('echo_on');
      should(second.w.writes.length).equal(0);
    }
  });

  it('should refuse a private code, which a terminal would echo', async () => {
    const error = await refused(build().service.raise(SESSION, { ...RAISE, sensitivity: 'private' }));

    should(error.code).equal('bad_request');
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
    should(w.trusted.has(digestLine('myapp'))).be.true();
    should(w.trusted.has('myapp')).be.false();
    should(w.writes.length).equal(1);
  });

  it('should not ask again for a program the owner trusts, nor for plain text', async () => {
    const odd: InputTargetFacts = {
      ...FACTS,
      recognisedConsumer: false,
      foreground: { ...FACTS.foreground, comm: 'myapp' },
    } as InputTargetFacts;
    const trusted = await raised({ facts: odd, trusted: new Set([digestLine('myapp')]) });
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

  it('should refuse the raising agent’s cancel before anything is read or changed', async () => {
    const { w, service, id } = await raised();
    const events = w.events.length;
    const audits = w.audits.length;
    const error = await refused(service.cancel(SESSION, id, AGENT));
    const missing = await refused(service.cancel(SESSION, 'e'.repeat(32), AGENT));

    should(error.code).equal('forbidden');
    should(missing.code).equal('forbidden');
    should(w.told.length).equal(0);
    should(w.closed.length).equal(0);
    should(w.events.length).equal(events);
    should(w.audits.length).equal(audits);
    should((await service.list(HOST)).length).equal(1);
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

describe('review regressions: delivery is one recorded, serialised, never-repeated write', () => {
  it('should record the delivery start durably BEFORE the write, then end uncertain and never type twice', async () => {
    const { w, service, id, digest } = await raised({ typeResult: 'uncertain' });
    const body = bodyFor(digest);
    const first = await refused(service.deliver(SESSION, id, body, HOST));
    const retry = await refused(service.deliver(SESSION, id, body, HOST));
    const other = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(first.code).equal('unavailable');
    should(first.message).containEql('will not type it again');
    should(retry).equal(first);
    should(other.code).equal('gone');
    should(w.writes.length).equal(1);
    should(w.order).eql(['surface.input_requested', 'surface.input_delivering', 'write', 'surface.input_refused']);
    should(w.events.find(event => event.type === 'surface.input_delivering')?.deliveryId).equal(body.deliveryId);
    should(w.events.at(-1)?.reason).equal('interrupted');
    should(w.told.at(-1)?.message).containEql('partly or fully typed');
    should(w.closed.length).equal(1);
    should((await service.list(HOST)).length).equal(0);
  });

  it('should treat a throwing write like an uncertain one', async () => {
    const { w, service, id, digest } = await raised({ typeThrows: true });
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(error.code).equal('unavailable');
    should(w.writes.length).equal(1);
    should(w.events.at(-1)?.reason).equal('interrupted');
  });

  it('should type nothing, hold nothing and stay pending when the delivery start cannot be recorded', async () => {
    const { w, service, values, id, digest } = await raised({ failJournal: 'surface.input_delivering' });
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(error.code).equal('unavailable');
    should(error.message).containEql('nothing was typed');
    should(w.writes.length).equal(0);
    should(values.heldCount()).equal(0);
    should((await service.list(HOST)).length).equal(1);
    w.failJournal = undefined;
    should((await service.deliver(SESSION, id, bodyFor(digest), HOST)).state).equal('delivered');
  });

  it('should ask nobody and keep nothing when the request cannot be recorded', async () => {
    const { w, service } = build({ failJournal: 'surface.input_requested' });
    const error = await refused(service.raise(SESSION, RAISE));

    should(error.code).equal('unavailable');
    should(w.closed.length).equal(1);
    should((await service.list(HOST)).length).equal(0);
    w.failJournal = undefined;
    should((await service.raise(SESSION, RAISE)).state).equal('pending');
  });

  it('should end a restart-time delivering request as interrupted and type nothing', async () => {
    const first = await raised();
    await first.service.deliver(SESSION, first.id, bodyFor(first.digest), HOST);
    const requested = first.w.events[0];
    const delivering = first.w.events.find(event => event.type === 'surface.input_delivering');
    if (requested === undefined || delivering === undefined) throw new Error('no events');

    const second = build({ history: [requested, delivering] });
    await second.service.restore();
    const promptless = build({ history: [requested, delivering], prompt: undefined });
    await promptless.service.restore();
    const browser = build({ history: [requested, { ...delivering, target: { kind: 'browser', key: 'app' } }] });
    await browser.service.restore();
    const again = build({ history: [delivering] });
    await again.service.restore();
    await again.service.restore();

    should(second.w.writes.length).equal(0);
    should((await second.service.list(HOST)).length).equal(0);
    should(second.w.events.at(-1)?.reason).equal('interrupted');
    should(second.w.told.at(-1)?.message).containEql('partly or fully typed');
    should(second.w.closed.length).equal(1);
    should(promptless.w.closed.length).equal(1);
    should(browser.w.closed.length).equal(0);
    should(again.w.closed.length).equal(1);
  });

  it('should leave the request pending, and pending after a restart, when the target changed at the last moment', async () => {
    const { w, service, id, digest } = await raised({ typeResult: 'target_changed' });
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    const restored = build({ history: [...w.events] });
    await restored.service.restore();

    should(error.reason).equal('target_changed');
    should(w.events.at(-1)?.type).equal('surface.input_requested');
    should((await service.list(HOST)).length).equal(1);
    should((await restored.service.list(HOST)).length).equal(1);
  });

  it('should make a raise wait for an agent turn and a secure write wait for both', async () => {
    const { w, service, id, digest } = await raised();
    let release: () => void = () => undefined;
    const turn = service.exclusive(SESSION, async () => await new Promise<void>(resolve => (release = resolve)));
    const observes = w.observes;
    const raise = service.raise(SESSION, { ...RAISE, target: { kind: 'terminal', key: 'other' } });
    const deliver = service.deliver(SESSION, id, bodyFor(digest), HOST);
    await new Promise(resolve => setTimeout(resolve, 0));

    should(w.observes).equal(observes);
    should(w.writes.length).equal(0);
    release();
    await turn;
    await Promise.all([raise, deliver]);
    should(w.writes.length).equal(1);
    should(w.cards.length).equal(2);
  });

  it('should admit one of two simultaneous raises on the same terminal, and no more than the capacity overall', async () => {
    const same = build();
    const results = await Promise.allSettled([same.service.raise(SESSION, RAISE), same.service.raise(SESSION, RAISE)]);
    const many = build();
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const crowd = await Promise.allSettled(
      keys.map(key => many.service.raise(SESSION, { ...RAISE, target: { kind: 'terminal', key } })),
    );

    should(results.filter(result => result.status === 'fulfilled')).have.length(1);
    should(same.w.cards.length).equal(1);
    should(crowd.filter(result => result.status === 'fulfilled')).have.length(3);
    should(many.w.cards.length).equal(3);
  });

  it('should recompute nothing from the agent: a cancel by the owner still works', async () => {
    const { w, service, id } = await raised();
    const request = await service.cancel(SESSION, id, DEVICE);

    should(request.state).equal('cancelled');
    should(w.audits.at(-1)?.actor).eql({ kind: 'device', deviceId: 'phone-1' });
  });
});

describe('review regressions: what the operator reads and how long values live', () => {
  it('should mask a value the terminal echoed from the prompt line and the command line the owner reads', async () => {
    const built = build();
    built.values.hold(SESSION, 'leaked-LEAK', 'A9');
    built.w.facts = {
      ...FACTS,
      promptLine: `Password: leaked-LEAK ${'x'.repeat(300)}`,
      foreground: { ...FACTS.foreground, argv: 'sudo --pass leaked-LEAK' },
    } as InputTargetFacts;
    await built.service.raise(SESSION, RAISE);
    const [request] = await built.service.list(HOST);
    const terminal = request?.observed?.kind === 'terminal' ? request.observed : undefined;

    should(JSON.stringify(request)).not.containEql('leaked-LEAK');
    should(terminal?.promptLine.startsWith('Password: [redacted:input A9]')).be.true();
    should(terminal?.promptLine.length).be.belowOrEqual(200);
    should(terminal?.foreground.argv).equal('sudo --pass [redacted:input A9]');
    should(request?.observedDigest).equal(digestFacts(built.w.facts));
  });

  it('should mask the owner-visible prompt and return the redacted request from a cancel', async () => {
    const { w, service, values, id } = await raised();
    values.hold(SESSION, 'sudo wants', 'A9');
    const cancelled = await service.cancel(SESSION, id, HOST);

    should(cancelled.prompt).containEql('[redacted:input A9]');
    should(w.events.at(-1)?.type).equal('surface.input_cancelled');
  });

  it('should let go of a value when its window ends, even if nobody reads, and when the session ends', async () => {
    const { w, service, values, id, digest } = await raised();
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    should(values.heldCount(SESSION)).equal(1);
    w.now += 601_000;
    await service.sweep();
    should(values.heldCount()).equal(0);

    const ended = await raised();
    await ended.service.deliver(SESSION, ended.id, bodyFor(ended.digest), HOST);
    ended.w.sessions.length = 0;
    await ended.service.sweep();
    should(ended.values.heldCount()).equal(0);
  });

  it('should end what a finished session left pending as interrupted without telling the gone agent', async () => {
    const { w, service, values } = await raised();
    values.hold(SESSION, 'v', 'A9');
    await service.sessionEnded(SESSION);
    await service.sessionEnded('someone-else');

    should(values.heldCount()).equal(0);
    should(w.events.at(-1)?.reason).equal('interrupted');
    should(w.closed.length).equal(1);
    should(w.told.length).equal(0);
    should((await service.list(HOST)).length).equal(0);
  });
});

describe('review regressions: what is shown is masked whole, then clipped, and nothing raw is kept', () => {
  const everything = (w: World, extra: unknown): string => JSON.stringify([w.cards, w.events, w.audits, w.told, extra]);

  it('should mask a long value whole before clipping, so no prefix of it survives the limit', async () => {
    const built = build();
    const long = `L${'0123456789'.repeat(37)}Z`;
    built.values.hold(SESSION, long, 'A9');
    built.w.facts = {
      ...FACTS,
      promptLine: `Password: ${long}`,
      foreground: { ...FACTS.foreground, argv: `sudo ${long}` },
    } as InputTargetFacts;
    await built.service.raise(SESSION, RAISE);
    const [request] = await built.service.list(HOST);
    const terminal = request?.observed?.kind === 'terminal' ? request.observed : undefined;

    should(terminal?.promptLine).equal('Password: [redacted:input A9]');
    should(terminal?.foreground.argv).equal('sudo [redacted:input A9]');
    should(everything(built.w, request)).not.containEql('0123456789');
  });

  it('should hide a prompt line that holds only a piece of a value, and show an ordinary one', async () => {
    const built = build();
    built.values.hold(SESSION, 'hunter2-UNIQUE', 'A9');
    built.w.facts = { ...FACTS, promptLine: 'Password: hunter2-UN' } as InputTargetFacts;
    await built.service.raise(SESSION, RAISE);
    const [wrapped] = await built.service.list(HOST);
    const piece = wrapped?.observed?.kind === 'terminal' ? wrapped.observed.promptLine : '';

    should(piece).startWith('[hidden:');
    should(piece).not.containEql('hunter2');

    const plain = build();
    plain.values.hold(SESSION, 'hunter2-UNIQUE', 'A9');
    await plain.service.raise(SESSION, RAISE);
    const [ordinary] = await plain.service.list(HOST);
    should(ordinary?.observed?.kind === 'terminal' ? ordinary.observed.promptLine : '').equal(
      '[sudo] password for kirin:',
    );
  });

  it('should show a program name that carries a value masked and clipped in the view, the card, the audit and the list', async () => {
    const built = build();
    built.values.hold(SESSION, 'leaked-LEAK', 'A9');
    built.w.facts = {
      ...FACTS,
      foreground: { ...FACTS.foreground, comm: `su-leaked-LEAK-${'x'.repeat(100)}` },
    } as InputTargetFacts;
    const view = await built.service.raise(SESSION, RAISE);
    const [request] = await built.service.list(HOST);
    const terminal = request?.observed?.kind === 'terminal' ? request.observed : undefined;

    should(view.observed?.consumer).equal(terminal?.foreground.comm);
    should(view.observed?.consumer).startWith('su-[redacted:input A9]-');
    should(view.observed?.consumer?.length).be.belowOrEqual(64);
    should(built.w.cards[0]?.ask).startWith('Type it into su-[redacted:input A9]');
    should(built.w.audits[0]?.detail.consumer).equal(view.observed?.consumer);
    should(everything(built.w, [view, request])).not.containEql('leaked-LEAK');
  });

  it('should keep no observed facts once a request ends, however it ends', async () => {
    const built = build();
    built.values.hold(SESSION, 'leaked-LEAK', 'A9');
    built.w.facts = {
      ...FACTS,
      promptLine: 'Password: leaked-LEAK',
      foreground: { ...FACTS.foreground, comm: 'leaked-LEAK' },
    } as InputTargetFacts;
    await built.service.raise(SESSION, RAISE);
    const [open] = await built.service.list(HOST);
    const cancelled = await built.service.cancel(SESSION, open?.id ?? '', HOST);

    should(cancelled.observed).be.undefined();
    should(cancelled.observedDigest).be.undefined();
    should(everything(built.w, cancelled)).not.containEql('leaked-LEAK');

    const ended = build();
    ended.values.hold(SESSION, 'leaked-LEAK', 'A9');
    ended.w.facts = { ...FACTS, foreground: { ...FACTS.foreground, comm: 'leaked-LEAK' } } as InputTargetFacts;
    await ended.service.raise(SESSION, RAISE);
    ended.w.now += 601_000;
    ended.w.sessions.length = 0;
    await ended.service.sweep();
    await ended.service.sessionEnded(SESSION);

    should(everything(ended.w, await ended.service.list(HOST))).not.containEql('leaked-LEAK');
  });
});

describe('the pane quarantine: a terminal a secret was typed into is kept from an agent for a window', () => {
  const NAMES = ['dev', '000000000001'];

  it('should hold the terminal under all its names once a secret is typed, and journal names and an end time only', async () => {
    const { w, service, quarantine, id, digest } = await raised({ names: NAMES });
    await service.deliver(SESSION, id, bodyFor(digest), HOST);

    should(service.quarantinedUntil(SESSION, ['000000000001'])).equal(w.now + 120_000);
    should(service.quarantinedUntil(SESSION, ['dev'])).equal(w.now + 120_000);
    should(service.quarantinedUntil(SESSION, ['other'])).be.undefined();
    should(w.quarantineEvents.map(event => event.type)).eql(['surface.input_quarantined']);
    should(w.quarantineEvents[0]?.names).eql(NAMES);
    should(JSON.stringify(w.quarantineEvents)).not.containEql(VALUE);
    should(w.order.indexOf('surface.input_delivering')).be.below(w.order.indexOf('write'));
    should(service.quarantines(HOST, SESSION)).eql([{ key: 'dev', until: '2026-10-30T12:02:00.000Z' }]);
    w.now += 120_000;
    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(quarantine.sessions()).eql([]);
  });

  it('should hold nothing for a plain answer', async () => {
    const { w, service, id, digest } = await raised({}, { ...RAISE, sensitivity: 'plain' });
    await service.deliver(SESSION, id, bodyFor(digest, {}, 'y'), HOST);

    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(w.quarantineEvents.length).equal(0);
    should(w.writes[0]?.text).equal('y');
  });

  it('should open the terminal up again when nothing was typed after all', async () => {
    const { w, service, id, digest } = await raised({ typeResult: 'target_changed' });
    await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(w.quarantineEvents.map(event => event.type)).eql([
      'surface.input_quarantined',
      'surface.input_quarantine_ended',
    ]);
  });

  it('should keep the terminal held when the write is uncertain, because something may be on screen', async () => {
    const { service, id, digest } = await raised({ typeResult: 'uncertain' });
    await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
  });

  it('should hold nothing when the delivery cannot be recorded', async () => {
    const { w, service, id, digest } = await raised({ failJournal: 'surface.input_delivering' });
    await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(w.quarantineEvents.map(event => event.type)).eql([
      'surface.input_quarantined',
      'surface.input_quarantine_ended',
    ]);
  });

  it('should still hold the terminal when the quarantine cannot be journalled', async () => {
    const { w, service, id, digest } = await raised();
    const journal = w.quarantineEvents;
    journal.push = () => {
      throw new Error('the journal is full');
    };
    await service.deliver(SESSION, id, bodyFor(digest), HOST);

    should(service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
  });

  it('should let only the owner see, end or reveal a quarantine, and record each', async () => {
    const { w, service, id, digest } = await raised();
    await service.deliver(SESSION, id, bodyFor(digest), DEVICE);

    should(() => service.quarantines(AGENT, SESSION)).throw();
    await refused(service.endQuarantine(AGENT, SESSION, 'dev'));
    await refused(service.revealed(AGENT, SESSION, 'dev'));
    await service.revealed(DEVICE, SESSION, 'dev');
    await service.endQuarantine(HOST, SESSION, 'dev');

    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(w.audits.map(entry => entry.event).slice(-2)).eql(['input.quarantine_revealed', 'input.quarantine_ended']);
    should(w.audits.at(-1)?.requestId).be.undefined();
    should(w.quarantineEvents.at(-1)?.type).equal('surface.input_quarantine_ended');
    const gone = await refused(service.endQuarantine(HOST, SESSION, 'dev'));
    should(gone.code).equal('not_found');
  });

  it('should come back after a restart for the time it had left, and not once it ended or was ended', async () => {
    const { w, service, id, digest } = await raised({ names: NAMES });
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    const started = w.quarantineEvents[0];
    if (started === undefined) throw new Error('no event');
    const ended = { ...started, type: 'surface.input_quarantine_ended' as const };

    const live = build({ quarantineHistory: [started], now: w.now + 60_000 });
    await live.service.restore();
    const over = build({ quarantineHistory: [started], now: w.now + 120_000 });
    await over.service.restore();
    const closed = build({ quarantineHistory: [started, ended], now: w.now + 60_000 });
    await closed.service.restore();
    const foreign = build({ quarantineHistory: [{ ...started, sessionId: 'x-1' }], now: w.now + 60_000 });
    await foreign.service.restore();

    should(live.service.quarantinedUntil(SESSION, ['000000000001'])).equal(w.now + 120_000);
    should(over.service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(closed.service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(foreign.service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
  });

  it('should let go of a session that ended', async () => {
    const { w, service, quarantine, id, digest } = await raised();
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    w.sessions = [];
    await service.sweep();

    should(quarantine.sessions()).eql([]);
  });
});
