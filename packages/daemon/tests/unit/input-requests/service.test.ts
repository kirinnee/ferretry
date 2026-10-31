import { describe, it } from 'bun:test';
import {
  type AgendaId,
  INPUT_MAX_REBINDS,
  type InputDeliverBody,
  type InputEvent,
  type InputQuarantineEvent,
  type InputRaise,
  type InputRequest,
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
  program: 'sudo',
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
  /** The foreground runs a code program the daemon proved from its executable (ObserveResult.codeProgram). */
  codeProgram: boolean;
  typeResult: TypeResult;
  cardOk: boolean;
  nextCard: number;
  sessions: string[];
  history: InputEvent[];
  writes: { text: string; submit: boolean }[];
  observes: number;
  /** Times the target was looked for again after it changed under the card. */
  refinds: number;
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
  /** Fails a quarantine journal append of this type (or every one with 'all'). */
  failQuarantine: string | undefined;
  /** Holds a quarantine journal append: the delay before the write. */
  quarantineGate: Promise<void> | undefined;
  /** The quarantine journal cannot be read. */
  quarantinesThrow: boolean;
  /** Fails every quarantine append once this many have been taken. */
  quarantineBudget: number | undefined;
  /** Holds the read of one session's quarantine journal. */
  quarantinesGate: { session: string; gate: Promise<void> } | undefined;
  /** Holds the read of the request history. */
  historyGate: Promise<void> | undefined;
  /** The request history cannot be read. */
  historyThrows: boolean;
  /** Holds the agenda's prompt lookup. */
  promptGate: Promise<void> | undefined;
  /** Holds every redaction of text the owner may be shown. */
  redactGate: Promise<void> | undefined;
  /** When set, only the redaction of this text waits at the redact gate. */
  redactOnly: string | undefined;
  /** How many redactions are suspended at the gate. */
  redacting: number;
  auditThrows: boolean;
  sessionsThrow: boolean;
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
    codeProgram: false,
    typeResult: 'typed',
    cardOk: true,
    nextCard: 1,
    sessions: [SESSION],
    history: [],
    writes: [],
    observes: 0,
    refinds: 0,
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
    failQuarantine: undefined,
    quarantineGate: undefined,
    quarantinesThrow: false,
    quarantinesGate: undefined,
    quarantineBudget: undefined,
    historyGate: undefined,
    historyThrows: false,
    promptGate: undefined,
    redactGate: undefined,
    redactOnly: undefined,
    redacting: 0,
    auditThrows: false,
    sessionsThrow: false,
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
          : {
              ok: true,
              facts: w.facts,
              ...(w.names === undefined ? {} : { names: w.names }),
              ...(w.codeProgram ? { codeProgram: true as const } : {}),
            };
      },
      // As the router does for a terminal: finding it again is looking again.
      refind: async (): Promise<ObserveResult> => {
        w.refinds += 1;
        return w.facts === undefined
          ? { ok: false, reason: w.observeReason }
          : {
              ok: true,
              facts: w.facts,
              ...(w.names === undefined ? {} : { names: w.names }),
              ...(w.codeProgram ? { codeProgram: true as const } : {}),
            };
      },
      type: async (_session, _target, values, submit) => {
        w.order.push('write');
        w.writes.push(...values.map(value => ({ text: value.text, submit })));
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
      promptOf: async () => {
        await w.promptGate;
        return w.prompt;
      },
    },
    notifier: { tell: async (_session, id, message) => void w.told.push({ id, message }) },
    journal: {
      publish: async (_session, event) => {
        if (w.failJournal === event.type) throw new Error('the journal is full');
        w.order.push(event.type);
        w.events.push(event);
      },
      history: async () => {
        await w.historyGate;
        if (w.historyThrows) throw new Error('the history cannot be read');
        return w.history;
      },
      quarantine: async (_session, event) => {
        await w.quarantineGate;
        if (w.failQuarantine === 'all' || w.failQuarantine === event.type) throw new Error('the journal is full');
        if (w.quarantineBudget !== undefined && w.quarantineEvents.length >= w.quarantineBudget)
          throw new Error('the journal is full');
        w.quarantineEvents.push(event);
      },
      quarantines: async session => {
        if (w.quarantinesGate?.session === session) await w.quarantinesGate.gate;
        if (w.quarantinesThrow) throw new Error('the journal cannot be read');
        return w.quarantineHistory;
      },
    },
    audit: {
      record: async entry => {
        if (entry.event === 'input.refused') await w.refusalAuditGate;
        if (w.auditThrows && entry.event === 'input.quarantine_revealed') throw new Error('the audit sink is down');
        w.audits.push(entry);
      },
      saved: async () => undefined,
      stored: async () => undefined,
    },
    clock,
    ids: { requestId: () => (w.nextId++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(resolve => w.sleeps.push(resolve)) },
    sessions: {
      ended: async id => !w.sessions.includes(id),
      all: async () => {
        if (w.sessionsThrow) throw new Error('storage is gone');
        return w.sessions;
      },
    },
    values,
    quarantine,
    redact: async text => {
      if (w.redactOnly === undefined || w.redactOnly === text) {
        w.redacting += w.redactGate === undefined ? 0 : 1;
        await w.redactGate;
      }
      return values.scrubAll(text);
    },
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

const buildWorld = (overrides: Partial<World> = {}) => build(overrides);
const raisedIn = async (over: Partial<World> = {}, raise: InputRaise = RAISE) => await raised(over, raise);

async function raised(over: Partial<World> = {}, raise: InputRaise = RAISE) {
  const built = build(over);
  const view = await built.service.raise(SESSION, raise);
  const [request] = await built.service.list(HOST);
  if (request === undefined) throw new Error('no request');
  return { ...built, view, request, id: request.id, digest: request.observedDigest ?? '' };
}

/** Another program now holds the terminal: a genuinely different target, which a Send must refuse and count. */
const ANOTHER_PROGRAM: InputTargetFacts = {
  ...FACTS,
  foreground: { ...FACTS.foreground, pid: 5100, comm: 'bash' },
  program: 'bash',
};

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
      lockSeconds: 120,
      note: 'Waiting for the owner on A1.',
    });
    should(w.cards[0]?.title).equal('Needs a secret');
    should(w.cards[0]?.ask).equal('Type it into the terminal');
    should(w.cards[0]?.blocking).be.true();
    should(request.expiresAt).equal('2026-10-30T12:10:00.000Z');
    should(w.events[0]?.type).equal('surface.input_requested');
    should(w.audits[0]?.event).equal('input.requested');
    should(w.audits[0]?.detail.consumer).be.undefined();
    should(w.audits[0]?.detail.recognised).equal(true);
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

  it('should refuse a page field that names no element', async () => {
    const { service } = build();
    const error = await refused(service.raise(SESSION, { ...RAISE, target: { kind: 'browser', key: 'app' } }));

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
    // Arrange — the first attempt is refused (another program held the terminal) and its audit is suspended. If
    // the lock covered only the write, the two correct Sends behind it would both pass their guards and type.
    const { w, service, id, digest } = await raised();
    let record: () => void = () => undefined;
    w.refusalAuditGate = new Promise<void>(resolve => {
      record = resolve;
    });

    // Act
    w.facts = ANOTHER_PROGRAM;
    const failing = service.deliver(SESSION, id, bodyFor(digest), HOST);
    await new Promise(resolve => setTimeout(resolve, 0));
    w.facts = FACTS;
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

  it('should refuse a card older than the request without counting it: target_rebound, zero writes', async () => {
    const { w, service, id, digest } = await raised();
    for (let n = 0; n < 5; n += 1) {
      const error = await refused(service.deliver(SESSION, id, bodyFor('c'.repeat(64)), HOST));
      should(error.code).equal('conflict');
      should(error.reason).equal('target_rebound');
    }

    should(w.writes.length).equal(0);
    should(w.audits.filter(entry => entry.event === 'input.refused')).eql([]);
    should((await service.deliver(SESSION, id, bodyFor(digest), HOST)).state).equal('delivered');
  });

  const mutations: readonly [string, (facts: InputTargetFacts & { kind: 'terminal' }) => InputTargetFacts][] = [
    ['pane', f => ({ ...f, paneProof: { ...f.paneProof, paneId: '%9' } })],
    ['pane pid', f => ({ ...f, paneProof: { ...f.paneProof, pid: 1 } })],
    ['foreground', f => ({ ...f, foreground: { ...f.foreground, pid: 9999 } })],
    ['program', f => ({ ...f, foreground: { ...f.foreground, comm: 'bash' }, program: 'bash' })],
    ['echo', f => ({ ...f, echo: 'on' })],
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

  it('should refuse when the pane vanishes between the check and the write and is not there again', async () => {
    const { w, service, id, digest } = await raised();
    w.typeResult = 'target_gone';
    let write: () => void = () => undefined;
    w.gate = new Promise<void>(resolve => {
      write = resolve;
    });
    const sending = refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    await new Promise(resolve => setTimeout(resolve, 0));
    should(w.writes.length).equal(1);
    w.facts = undefined;
    write();
    const error = await sending;

    should(error.reason).equal('target_changed');
    should(w.refinds).equal(1);
    should((await service.list(HOST)).length).equal(1);
  });

  it('should end the request after three failed checks, saying why in plain words', async () => {
    const { w, service, id, digest } = await raised();
    w.facts = ANOTHER_PROGRAM;
    const errors: InputRequestError[] = [];
    for (let n = 0; n < 3; n += 1) errors.push(await refused(service.deliver(SESSION, id, bodyFor(digest), HOST)));
    const after = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    // Another target, three times: it never says "kept changing", which would invite a fresh request on it.
    should(errors.map(error => error.reason)).eql(['target_changed', 'target_changed', 'target_changed']);
    should(after.code).equal('gone');
    should(w.events.at(-1)?.type).equal('surface.input_refused');
    should(w.audits.at(-1)?.detail.reason).equal('check_failures');
    should(w.closed.at(-1)?.note).equal(
      'The terminal is no longer what you approved, so nothing was typed. Look at it before the ferret asks again.',
    );
    should(w.told.at(-1)?.message).containEql('(refused: the terminal is no longer what the owner approved)');
    should(w.told.at(-1)?.message).not.containEql('check failures');
    should(w.writes.length).equal(0);
  });

  it('should record each failed check without ending the request', async () => {
    const { w, service, id, digest } = await raised();
    w.facts = ANOTHER_PROGRAM;
    await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(w.audits.at(-1)?.event).equal('input.refused');
    should(w.audits.at(-1)?.detail.reason).equal('target_changed');
  });

  it('should flag a secret amber, and still raise and type it, when echo is on or cannot be told', async () => {
    for (const echo of ['on', 'unknown'] as const) {
      const { w, service, id, digest } = await raised({ facts: { ...FACTS, echo } });
      const [card] = await service.list(HOST);
      const done = await service.deliver(SESSION, id, bodyFor(digest), HOST);

      should(card?.risk?.level).equal('amber');
      should(card?.risk?.reason).containEql('echo');
      should(done.state).equal('delivered');
      should(w.writes.length).equal(1);
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

  it('should bring an amber card back after a restart, flagged the same and still sendable', async () => {
    for (const echo of ['on', 'unknown'] as const) {
      const first = await raised({ facts: { ...FACTS, echo } });
      const second = build({ history: [...first.w.events], facts: { ...FACTS, echo } });
      await second.service.restore();
      const [back] = await second.service.list(HOST);
      const done = await second.service.deliver(SESSION, back?.id ?? '', bodyFor(back?.observedDigest ?? ''), HOST);

      should(back?.risk?.level).equal('amber');
      should(done.state).equal('delivered');
      should(second.w.writes.length).equal(1);
    }
  });

  it('should accept a private code, flag it amber and quarantine the terminal like a secret', async () => {
    const { w, service, values, id, digest, view } = await raised({}, { ...RAISE, sensitivity: 'private' });
    const [card] = await service.list(HOST);
    const done = await service.deliver(SESSION, id, bodyFor(digest), HOST);

    should(view.state).equal('pending');
    should(card?.risk?.level).equal('amber');
    should(card?.risk?.reason).containEql('show on screen');
    should(card?.risk?.reason).containEql('2 minutes');
    should(done.state).equal('delivered');
    should(w.writes).eql([{ text: VALUE, submit: true }]);
    should(values.scrub(SESSION, VALUE)).equal('[redacted:input A1]');
    should(w.quarantineEvents.length).be.above(0);
  });

  it('should still refuse a private code with a control character', async () => {
    const { service, id, digest } = await raised({}, { ...RAISE, sensitivity: 'private' });
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest, {}, '12\n34'), HOST));

    should(error.code).equal('bad_request');
  });

  it('should flag a recognised program with typing hidden green, an unrecognised one amber, and plain text red', async () => {
    const odd: InputTargetFacts = {
      ...FACTS,
      recognisedConsumer: false,
      foreground: { ...FACTS.foreground, comm: 'myapp' },
      program: 'myapp',
    } as InputTargetFacts;
    const green = await raised();
    const amber = await raised({ facts: odd });
    const red = await raised({ facts: odd }, { ...RAISE, sensitivity: 'plain' });
    const [greenCard] = await green.service.list(HOST);
    const [amberCard] = await amber.service.list(HOST);
    const [redCard] = await red.service.list(HOST);

    should(greenCard?.risk?.level).equal('green');
    should(amberCard?.risk?.level).equal('amber');
    should(amberCard?.risk?.reason).not.containEql('myapp');
    should(redCard?.risk?.level).equal('red');
    should(redCard?.risk?.reason).equal('Not secret: the ferret can see this value.');
  });

  it('should flag an UNVERIFIED reader amber with the full lock, even when ps calls it sudo', async () => {
    // Arrange — a ferret's shell renamed itself sudo: echo off, line mode, but the kernel proved no program.
    const disguised = {
      ...FACTS,
      recognisedConsumer: false,
      canonical: true,
      program: undefined,
      trustedProgram: undefined,
    } as InputTargetFacts;

    // Act
    const [card] = await (await raised({ facts: disguised })).service.list(HOST);

    // Assert
    should(card?.risk?.level).equal('amber');
    should(card?.risk?.reason).startWith('Unverified: Ferretry could not prove which program is reading the terminal');
    should(card?.risk?.reason).not.containEql('sudo');
  });

  it('should type a secret into an unrecognised program without any extra tick, since the flag is the warning', async () => {
    const odd: InputTargetFacts = {
      ...FACTS,
      recognisedConsumer: false,
      foreground: { ...FACTS.foreground, comm: 'myapp' },
      program: 'myapp',
    } as InputTargetFacts;
    const { w, service, id, digest } = await raised({ facts: odd });
    const ok = await service.deliver(SESSION, id, bodyFor(digest), HOST);

    should(ok.state).equal('delivered');
    should(w.writes.length).equal(1);
  });

  it('should refuse a value with control characters or a newline for a secret, and a bad shape for any', async () => {
    const { w, service, id, digest } = await raised();
    const enter = await refused(service.deliver(SESSION, id, bodyFor(digest, {}, 'pass\nrm -rf'), HOST));
    const shape = await refused(service.deliver(SESSION, id, bodyFor(digest, { padded: 'hunter2' }), HOST));
    const saved = await refused(
      service.deliver(SESSION, id, bodyFor(digest, { padded: undefined, entry: 'DEPLOY_KEY' }), HOST),
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

describe('R7: the agent is never sent to chat for a value', () => {
  const guided = (message: string | undefined): void => {
    should(message).containEql('terminal_request_input');
    should(message).containEql('take over');
    should(message?.toLowerCase()).not.containEql('chat');
  };

  for (const sensitivity of ['secret', 'private'] as const) {
    const raise = { ...RAISE, sensitivity };

    it(`should point a ${sensitivity} request that was interrupted to a fresh request, not chat`, async () => {
      const { w, service, id, digest } = await raised({ typeResult: 'uncertain' }, raise);
      await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

      should(w.told.at(-1)?.message).containEql('partly or fully typed');
      guided(w.told.at(-1)?.message);
    });

    it(`should point a cancelled ${sensitivity} request to a fresh request, not chat`, async () => {
      const { w, service, id } = await raised({}, raise);
      await service.cancel(SESSION, id, HOST);

      guided(w.told.at(-1)?.message);
    });

    it(`should point an expired ${sensitivity} request to a fresh request, not chat`, async () => {
      const { w, service } = await raised({}, raise);
      w.now += 600_000;
      await service.sweep();

      guided(w.told.at(-1)?.message);
    });

    it(`should point a refused ${sensitivity} request to a fresh request, not chat`, async () => {
      const { w, service, id, digest } = await raised({}, raise);
      w.facts = ANOTHER_PROGRAM;
      for (let n = 0; n < 4; n += 1) await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

      should(w.told.at(-1)?.message).containEql('no longer what the owner approved');
      guided(w.told.at(-1)?.message);
    });
  }
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
    // A page can take a request now, so one interrupted mid-write ends like a terminal's.
    should(browser.w.closed.length).equal(1);
    should(again.w.closed.length).equal(1);
  });

  it('should leave the request pending, and pending after a restart, when the target changed at the last moment', async () => {
    const { w, service, id, digest } = await raised({ typeResult: 'target_changed' });
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    const restored = build({ history: [...w.events] });
    await restored.service.restore();

    // Looked at again it is the same prompt: the card is redrawn, and the owner sends again.
    should(error.reason).equal('target_rebound');
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
    should(built.w.cards[0]?.ask).equal('Type it into the terminal');
    should(built.w.audits[0]?.detail.consumer).be.undefined();
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
  const WINDOW = 120_000;
  const STARTED = 'surface.input_quarantined';
  const ENDED = 'surface.input_quarantine_ended';
  // These are about the hold itself at its FULL window: a terminal the daemon has not proven hides typing (a program
  // it does not recognise) is held the whole 120 s. A proven one's short lock is in lock-service.test.ts.
  const UNPROVEN = { ...FACTS, recognisedConsumer: false };
  const build = (over: Partial<World> = {}) => buildWorld({ facts: UNPROVEN, ...over });
  const raised = async (over: Partial<World> = {}, raise: InputRaise = RAISE) =>
    await raisedIn({ facts: UNPROVEN, ...over }, raise);

  it('should hold the terminal under all its names once a secret is typed, and journal names and an end time only', async () => {
    const { w, service, quarantine, id, digest } = await raised({ names: NAMES });
    await service.deliver(SESSION, id, bodyFor(digest), HOST);

    should(service.quarantinedUntil(SESSION, ['000000000001'])).equal(w.now + WINDOW);
    should(service.quarantinedUntil(SESSION, ['dev'])).equal(w.now + WINDOW);
    should(service.quarantinedUntil(SESSION, ['other'])).be.undefined();
    should(w.quarantineEvents.map(event => event.type)).eql([STARTED, STARTED]);
    should(w.quarantineEvents[0]?.names).eql(NAMES);
    should(w.quarantineEvents[0]?.hold).equal(w.quarantineEvents[1]?.hold);
    should(JSON.stringify(w.quarantineEvents)).not.containEql(VALUE);
    should(w.order.indexOf(STARTED)).be.below(w.order.indexOf('write'));
    should(w.order.indexOf('surface.input_delivering')).be.below(w.order.indexOf('write'));
    should(service.quarantines(HOST, SESSION)).eql([{ key: 'dev', until: '2026-10-30T12:02:00.000Z' }]);
    w.now += WINDOW;
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
    should(w.quarantineEvents.map(event => event.type)).eql([STARTED, ENDED]);
  });

  it('should keep the terminal held when the write is uncertain, because something may be on screen', async () => {
    const { service, id, digest } = await raised({ typeResult: 'uncertain' });
    await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
  });

  it('should keep the terminal held when the write throws after it began', async () => {
    const { service, id, digest } = await raised({ typeThrows: true });
    await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
  });

  it('should hold nothing when the delivery cannot be recorded', async () => {
    const { w, service, id, digest } = await raised({ failJournal: 'surface.input_delivering' });
    await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(w.writes.length).equal(0);
    should(w.quarantineEvents.map(event => event.type)).eql([STARTED, ENDED]);
  });

  // Q1
  it('should type nothing when the quarantine cannot be journalled, and leave nothing held for it', async () => {
    const { w, service, id, digest } = await raised({ failQuarantine: 'all' });

    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

    should(error.code).equal('unavailable');
    should(w.writes.length).equal(0);
    should(w.order).not.containEql('surface.input_delivering');
    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    w.failQuarantine = undefined;
    const retried = await service.deliver(SESSION, id, bodyFor(digest), HOST);
    should(retried.state).equal('delivered');
    should(w.writes.length).equal(1);
  });

  // Q1
  it('should leave a terminal held after a restart when the append failed once and the next attempt went through', async () => {
    const first = await raised({ failQuarantine: STARTED });
    await refused(first.service.deliver(SESSION, first.id, bodyFor(first.digest), HOST));
    first.w.failQuarantine = undefined;
    await first.service.deliver(SESSION, first.id, bodyFor(first.digest), HOST);
    const restarted = build({ quarantineHistory: first.w.quarantineEvents, now: first.w.now + 1 });

    await restarted.service.restore();

    should(first.w.writes.length).equal(1);
    should(restarted.service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
  });

  // Q1
  it('should still hold a terminal after a restart when the process died between the journal and the write', async () => {
    const { w, service, id, digest } = await raised({ names: NAMES });
    w.gate = new Promise<void>(() => undefined);
    void service.deliver(SESSION, id, bodyFor(digest), HOST);
    await new Promise(resolve => setTimeout(resolve, 0));

    const restarted = build({
      quarantineHistory: w.quarantineEvents,
      history: w.events,
      now: w.now + 30_000,
    });
    await restarted.service.restore();

    should(w.writes.length).equal(1);
    should(restarted.service.quarantinedUntil(SESSION, ['000000000001'])).not.be.undefined();
    should(restarted.w.writes.length).equal(0);
  });

  // Q2
  it('should leave an earlier delivery held when a later attempt on the same terminal is refused', async () => {
    const { w, service, id, digest } = await raised({ names: NAMES });
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    const heldUntil = w.now + WINDOW;
    w.now += 30_000;
    w.facts = { ...FACTS };
    await service.raise(SESSION, RAISE);
    const [second] = await service.list(HOST);
    w.typeResult = 'target_changed';
    await refused(service.deliver(SESSION, second?.id ?? '', bodyFor(second?.observedDigest ?? ''), HOST));

    should(service.quarantinedUntil(SESSION, ['dev'])).equal(heldUntil);
    should(service.quarantinedUntil(SESSION, ['000000000001'])).equal(heldUntil);
  });

  // Q2
  it('should leave an earlier delivery held when a later attempt cannot record its delivering event, now and after a restart', async () => {
    const { w, service, id, digest } = await raised({ names: NAMES });
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    const heldUntil = w.now + WINDOW;
    w.now += 30_000;
    await service.raise(SESSION, RAISE);
    const [second] = await service.list(HOST);
    w.failJournal = 'surface.input_delivering';
    await refused(service.deliver(SESSION, second?.id ?? '', bodyFor(second?.observedDigest ?? ''), HOST));
    const restarted = build({ quarantineHistory: w.quarantineEvents, now: w.now });
    await restarted.service.restore();

    should(service.quarantinedUntil(SESSION, ['dev'])).equal(heldUntil);
    should(restarted.service.quarantinedUntil(SESSION, ['dev'])).equal(heldUntil);
  });

  // Q7
  it('should keep the hold open while the journal is slow, so the window cannot run out before the write', async () => {
    const { w, service, id, digest } = await raised();
    let release: () => void = () => undefined;
    w.quarantineGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const delivering = service.deliver(SESSION, id, bodyFor(digest), HOST);
    await new Promise(resolve => setTimeout(resolve, 0));

    w.now += WINDOW + 1;
    should(service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
    w.quarantineGate = undefined;
    release();
    await delivering;

    should(service.quarantinedUntil(SESSION, ['dev'])).equal(w.now + WINDOW);
  });

  // Q7
  it('should keep the hold open while the write itself is suspended', async () => {
    const { w, service, id, digest } = await raised();
    let release: () => void = () => undefined;
    w.gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const delivering = service.deliver(SESSION, id, bodyFor(digest), HOST);
    await new Promise(resolve => setTimeout(resolve, 0));

    w.now += 5 * WINDOW;
    should(service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
    release();
    await delivering;

    should(service.quarantinedUntil(SESSION, ['dev'])).equal(w.now + WINDOW);
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
    should(w.quarantineEvents.at(-1)?.type).equal(ENDED);
    const gone = await refused(service.endQuarantine(HOST, SESSION, 'dev'));
    should(gone.code).equal('not_found');
  });

  it('should refuse to reveal a quarantined terminal when the reveal cannot be recorded', async () => {
    const { w, service, id, digest } = await raised({ auditThrows: true });
    await service.deliver(SESSION, id, bodyFor(digest), HOST);

    const error = await refused(service.revealed(HOST, SESSION, 'dev'));

    should(error.code).equal('unavailable');
    should(w.audits.some(entry => entry.event === 'input.quarantine_revealed')).be.false();
  });

  it('should come back after a restart for the time it had left, and not once it ended or was ended', async () => {
    const { w, service, id, digest } = await raised({ names: NAMES });
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    const started = w.quarantineEvents.at(-1);
    if (started === undefined) throw new Error('no event');
    const ended = { ...started, type: ENDED as typeof started.type };

    const live = build({ quarantineHistory: [started], now: w.now + 60_000 });
    await live.service.restore();
    const over = build({ quarantineHistory: [started], now: w.now + WINDOW });
    await over.service.restore();
    const closed = build({ quarantineHistory: [started, ended], now: w.now + 60_000 });
    await closed.service.restore();
    const foreign = build({ quarantineHistory: [{ ...started, sessionId: 'x-1' }], now: w.now + 60_000 });
    await foreign.service.restore();

    should(live.service.quarantinedUntil(SESSION, ['000000000001'])).equal(w.now + WINDOW);
    should(over.service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(closed.service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
    should(foreign.service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
  });

  it('should keep one attempt’s hold when another attempt on the terminal let go of its own, in the journal', async () => {
    const at = '2026-10-30T12:00:00.000Z';
    const event = (type: string, hold: string, until: string) =>
      ({ type, sessionId: SESSION, names: ['dev'], hold, until, at }) as InputQuarantineEvent;
    const { service } = build({
      quarantineHistory: [
        event(STARTED, 'a/1', '2026-10-30T12:02:00.000Z'),
        event(STARTED, 'b/2', '2026-10-30T12:04:00.000Z'),
        event(ENDED, 'b/2', at),
      ],
      now: Date.parse(at) + 30_000,
    });

    await service.restore();

    should(service.quarantinedUntil(SESSION, ['dev'])).equal(Date.parse('2026-10-30T12:02:00.000Z'));
  });

  // Q4
  it('should hold every terminal while recovery runs, however slow the observation of a request is', async () => {
    const live = await raised({ names: NAMES });
    await live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
    let open: () => void = () => undefined;
    const stalled = build({
      quarantineHistory: live.w.quarantineEvents,
      history: [
        {
          ...live.w.events[0],
          type: 'surface.input_requested',
          state: 'pending',
          expiresAt: '2026-10-30T12:10:00.000Z',
        } as InputEvent,
      ],
      observeGate: new Promise<void>(resolve => {
        open = resolve;
      }),
      now: live.w.now + 30_000,
    });
    stalled.quarantine.lock();

    const restoring = stalled.service.restore();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(stalled.service.quarantinedUntil(SESSION, ['dev'])).equal(live.w.now + WINDOW);
    open();
    await restoring;
    should(stalled.service.quarantinedUntil(SESSION, ['dev'])).equal(live.w.now + WINDOW);
    should(stalled.service.quarantinedUntil(SESSION, ['unrelated'])).be.undefined();
  });

  // Q4
  it('should hold a session whose quarantine journal cannot be read, and not another', async () => {
    const { w, service } = build({ quarantinesThrow: true, sessions: [SESSION] });
    w.sessions = [SESSION];

    await service.restore();

    should(service.quarantinedUntil(SESSION, ['anything'])).equal(w.now + WINDOW);
    should(service.quarantinedUntil('x-1', ['anything'])).be.undefined();
  });

  // Q4
  it('should keep every terminal held, for a window, when the sessions cannot be listed', async () => {
    const { w, service, quarantine } = build({ sessionsThrow: true });
    quarantine.lock();

    await service.restore().catch(() => undefined);

    should(quarantine.until('x-1', ['anything'])).equal(w.now + WINDOW);
    w.now += WINDOW;
    should(quarantine.until('x-1', ['anything'])).be.undefined();
  });

  // Q4
  it('should replay a later session’s quarantine before it revives an earlier session’s requests', async () => {
    const at = '2026-10-30T12:00:00.000Z';
    let open: () => void = () => undefined;
    const { service } = build({
      sessions: [SESSION, 'x-1'],
      history: [
        {
          type: 'surface.input_requested',
          requestId: 'r2',
          agendaItemId: 'A9',
          sessionId: SESSION,
          target: { kind: 'terminal', key: 'dev' },
          sensitivity: 'plain',
          submit: 'offer-owner',
          state: 'pending',
          expiresAt: '2026-10-30T12:10:00.000Z',
          at,
        } as InputEvent,
      ],
      quarantineHistory: [
        {
          type: STARTED,
          sessionId: 'x-1',
          names: ['dev'],
          until: '2026-10-30T12:02:00.000Z',
          at,
        } as InputQuarantineEvent,
      ],
      observeGate: new Promise<void>(resolve => {
        open = resolve;
      }),
    });

    const restoring = service.restore();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(service.quarantinedUntil('x-1', ['dev'])).equal(Date.parse('2026-10-30T12:02:00.000Z'));
    open();
    await restoring;
  });

  // Q5
  it('should show a follow-up request on a held terminal no prompt line, argv or program name', async () => {
    const first = await raised({ names: NAMES });
    await first.service.deliver(SESSION, first.id, bodyFor(first.digest), HOST);
    first.w.facts = {
      ...FACTS,
      promptLine: `login: ${VALUE}`,
      foreground: { ...FACTS.foreground, comm: VALUE, argv: `tool --password=${VALUE}` },
    };

    const view = await first.service.raise(SESSION, { ...RAISE, sensitivity: 'plain' });
    const listed = JSON.stringify(await first.service.list(HOST));

    should(JSON.stringify(view)).not.containEql(VALUE);
    should(listed).not.containEql(VALUE);
    should(JSON.stringify(first.w.cards)).not.containEql(VALUE);
    should(JSON.stringify(first.w.audits)).not.containEql(VALUE);
    should(view.observed?.consumer).containEql('hidden');
  });

  // Q5
  it('should show a restored request on a held terminal no prompt line, argv or program name', async () => {
    const live = await raised({ names: NAMES });
    await live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
    const restarted = build({
      quarantineHistory: live.w.quarantineEvents,
      history: [
        {
          type: 'surface.input_requested',
          requestId: 'r2',
          agendaItemId: 'A9',
          sessionId: SESSION,
          target: { kind: 'terminal', key: 'dev' },
          sensitivity: 'plain',
          submit: 'offer-owner',
          state: 'pending',
          expiresAt: '2026-10-30T12:10:00.000Z',
          at: '2026-10-30T12:00:00.000Z',
        } as InputEvent,
      ],
      facts: {
        ...FACTS,
        promptLine: `login: ${VALUE}`,
        foreground: { ...FACTS.foreground, comm: VALUE, argv: `tool ${VALUE}` },
      },
      now: live.w.now + 30_000,
    });

    await restarted.service.restore();
    const listed = JSON.stringify(await restarted.service.list(HOST));

    should(listed).containEql('r2');
    should(listed).not.containEql(VALUE);
    restarted.w.now += WINDOW;
    should(JSON.stringify(await restarted.service.list(HOST))).not.containEql(VALUE);
  });

  // Q5
  it('should keep a quarantined consumer name out of the audit record of the delivery', async () => {
    const { w, service, id, digest } = await raised();
    await service.deliver(SESSION, id, bodyFor(digest), HOST);

    const delivered = w.audits.find(entry => entry.event === 'input.delivered');

    should(JSON.stringify(delivered)).not.containEql('"consumer":"sudo"');
  });

  // R9-3
  it('should word the agenda card without any program the pane named', async () => {
    const CANARY = 'pane-consumer-CANARY';
    const built = build();
    built.w.facts = { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY } } as InputTargetFacts;

    await built.service.raise(SESSION, RAISE);

    should(JSON.stringify(built.w.cards)).not.containEql(CANARY);
  });

  // R9-2
  it('should record no program name in any audit entry, held or not', async () => {
    const CANARY = 'pane-consumer-CANARY';
    const live = await raised({ facts: { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY } }, names: NAMES });
    await live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);

    should(live.w.audits.length).be.above(1);
    should(JSON.stringify(live.w.audits)).not.containEql(CANARY);
  });

  describe('audit records while a terminal is held', () => {
    const CANARY = 'pane-consumer-CANARY';
    const facts = { ...FACTS, foreground: { ...FACTS.foreground, comm: CANARY } };

    // R8-3
    it('should keep the consumer out of the record of a refused check on a request whose terminal is held', async () => {
      const live = await raised({ facts, names: NAMES });
      await live.service.raise(SESSION, { ...RAISE, target: { kind: 'terminal', key: '000000000001' } });
      const second = (await live.service.list(HOST)).find(request => request.id !== live.id);
      await live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
      should(live.service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();

      // A redraw first (the prompt a row lower), then a refused check (echo came on): neither record names it.
      live.w.facts = { ...facts, cursorRow: 5 };
      await live.service
        .deliver(SESSION, second?.id ?? '', bodyFor(second?.observedDigest ?? ''), HOST)
        .catch(() => undefined);
      const redrawn = (await live.service.list(HOST)).find(request => request.id === second?.id);
      live.w.facts = { ...facts, echo: 'on' };
      await live.service
        .deliver(SESSION, second?.id ?? '', bodyFor(redrawn?.observedDigest ?? ''), HOST)
        .catch(() => undefined);

      const record = live.w.audits.filter(entry => entry.event === 'input.refused').at(-1);
      const rebound = live.w.audits.filter(entry => entry.event === 'input.rebound').at(-1);
      should(record).not.be.undefined();
      should(rebound).not.be.undefined();
      should(JSON.stringify([record, rebound])).not.containEql(CANARY);
    });

    // R8-3
    it('should keep the consumer out of the record of a request raised on a terminal that is already held', async () => {
      const live = await raised({ facts, names: NAMES });
      await live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);

      await live.service.raise(SESSION, RAISE);

      const record = live.w.audits.filter(entry => entry.event === 'input.requested').at(-1);
      should(JSON.stringify(record)).not.containEql(CANARY);
    });

    // R8-3
    it('should keep the consumer out of the cancellation record when a hold begins while the cancellation is journalled', async () => {
      const live = await raised({ facts, names: NAMES });
      const journal = live.w.events;
      const publish = (
        live.service as unknown as { deps: { journal: { publish: (s: string, e: InputEvent) => Promise<void> } } }
      ).deps.journal.publish;
      (live.service as unknown as { deps: { journal: { publish: typeof publish } } }).deps.journal.publish = async (
        session: string,
        event: InputEvent,
      ) => {
        await publish(session, event);
        if (event.state === 'cancelled') live.quarantine.begin(SESSION, NAMES, 'concurrent');
      };

      await live.service.cancel(SESSION, live.id, HOST);

      should(journal.at(-1)?.state).equal('cancelled');
      should(live.service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
      const record = live.w.audits.filter(entry => entry.event === 'input.cancelled').at(-1);
      should(JSON.stringify(record)).not.containEql(CANARY);
    });
  });

  it('should hold a restored delivering request’s terminal for a fresh window, because the write may have landed', async () => {
    const live = await raised({ names: NAMES });
    live.w.gate = new Promise<void>(() => undefined);
    void live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
    await new Promise(resolve => setTimeout(resolve, 0));
    const restarted = build({
      history: live.w.events,
      quarantineHistory: live.w.quarantineEvents,
      now: live.w.now + 10 * WINDOW,
    });

    await restarted.service.restore();

    should(live.w.quarantineEvents[0]?.unresolved).equal(true);
    should(restarted.service.quarantinedUntil(SESSION, ['dev'])).equal(restarted.w.now + WINDOW);
    should(restarted.service.quarantinedUntil(SESSION, ['000000000001'])).equal(restarted.w.now + WINDOW);
    should(restarted.w.quarantineEvents.at(-1)?.type).equal(STARTED);
    should(restarted.w.quarantineEvents.at(-1)?.unresolved).be.undefined();
    should(restarted.w.writes.length).equal(0);
  });

  describe('R6: a hold taken while a card is being redacted still seals it (one publication gate)', () => {
    const sealed = (request: InputRequest | undefined): void => {
      const facts = request?.observed;
      if (facts?.kind !== 'terminal') {
        should(JSON.stringify(request)).not.containEql(FACTS.promptLine);
        return;
      }
      should(facts.promptLine).not.equal(FACTS.promptLine);
      should(facts.foreground.argv).equal('');
    };

    const suspended = async (w: { redacting: number }): Promise<void> => {
      for (let n = 0; n < 50 && w.redacting === 0; n += 1) await new Promise(resolve => setTimeout(resolve, 0));
      should(w.redacting).be.above(0);
    };

    it('should seal a listed card when a hold began while its text was being redacted', async () => {
      const live = await raised({ names: NAMES });
      let open!: () => void;
      live.w.redactGate = new Promise<void>(resolve => (open = resolve));
      live.w.redactOnly = FACTS.promptLine;

      const pending = live.service.list(HOST);
      await suspended(live.w);
      live.quarantine.lockSession(SESSION);
      open();
      const [request] = await pending;

      sealed(request);
    });

    // R8-4
    it('should seal a card that finished projection first, when a hold begins while a later card in the batch is still being redacted', async () => {
      const live = await raised({ names: NAMES });
      await live.service.raise(SESSION, {
        ...RAISE,
        target: { kind: 'terminal', key: 'other' },
        prompt: 'second-prompt',
      });
      let open!: () => void;
      live.w.redactGate = new Promise<void>(resolve => (open = resolve));
      live.w.redactOnly = 'second-prompt';

      const pending = live.service.list(HOST);
      await suspended(live.w);
      live.quarantine.lockSession(SESSION);
      open();
      const listed = await pending;

      should(listed.length).equal(2);
      for (const request of listed) sealed(request);
    });

    // An ended request keeps no observed facts at all, so this pins the invariant rather than a race.
    it('should show a cancelled card no terminal text, even when a hold began while its prompt was being redacted', async () => {
      const live = await raised({ names: NAMES });
      let open!: () => void;
      live.w.redactGate = new Promise<void>(resolve => (open = resolve));

      const pending = live.service.cancel(SESSION, live.id, HOST);
      await suspended(live.w);
      live.quarantine.lockSession(SESSION);
      open();

      sealed(await pending);
    });
  });

  describe('R6: recovery evidence outlives the request and holds every name', () => {
    const afterRestart = (live: {
      w: { events: InputEvent[]; quarantineEvents: InputQuarantineEvent[]; now: number };
    }) => build({ history: live.w.events, quarantineHistory: live.w.quarantineEvents, now: live.w.now + 10 * WINDOW });

    // R7-1
    it('should keep a live delivery pinned, under every alias, while a stalled multi-session replay finishes', async () => {
      let open: () => void = () => undefined;
      const live = build({ sessions: [SESSION, 'x-2'], names: NAMES });
      live.w.quarantinesGate = {
        session: 'x-2',
        gate: new Promise<void>(resolve => {
          open = resolve;
        }),
      };
      const restoring = live.service.restore();
      await new Promise(resolve => setTimeout(resolve, 0));
      await live.service.raise(SESSION, RAISE);
      const [request] = await live.service.list(HOST);
      let finish: () => void = () => undefined;
      live.w.gate = new Promise<void>(resolve => {
        finish = resolve;
      });
      const delivering = live.service.deliver(SESSION, request?.id ?? '', bodyFor(request?.observedDigest ?? ''), HOST);
      await new Promise(resolve => setTimeout(resolve, 0));

      open();
      await restoring;
      live.w.now += WINDOW + 1;

      should(live.service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
      should(live.service.quarantinedUntil(SESSION, ['000000000001'])).not.be.undefined();
      finish();
      await delivering;
      should(live.service.quarantinedUntil(SESSION, ['dev'])).equal(live.w.now + WINDOW);
      should(live.service.quarantinedUntil(SESSION, ['000000000001'])).equal(live.w.now + WINDOW);
    });
    // R8-1
    it('should keep a live delivery pinned, under every alias, when its own session replay read was stalled and then reads the live hold', async () => {
      let open: () => void = () => undefined;
      const live = build({ names: NAMES });
      live.w.quarantinesGate = {
        session: SESSION,
        gate: new Promise<void>(resolve => {
          open = resolve;
        }),
      };
      live.w.quarantineHistory = live.w.quarantineEvents;
      live.quarantine.lock();
      const restoring = live.service.restore();
      await new Promise(resolve => setTimeout(resolve, 0));
      await live.service.raise(SESSION, RAISE);
      const [request] = await live.service.list(HOST);
      let finish: () => void = () => undefined;
      live.w.gate = new Promise<void>(resolve => {
        finish = resolve;
      });
      const delivering = live.service.deliver(SESSION, request?.id ?? '', bodyFor(request?.observedDigest ?? ''), HOST);
      await new Promise(resolve => setTimeout(resolve, 0));
      should(live.w.writes.length).equal(1);

      open();
      await restoring;

      should(live.quarantine.unresolved(SESSION).length).equal(1);
      should(live.w.quarantineEvents.at(-1)?.unresolved).equal(true);
      should(live.w.quarantineEvents.filter(event => event.unresolved !== true)).eql([]);
      const restarted = build({
        history: live.w.events,
        quarantineHistory: live.w.quarantineEvents,
        now: live.w.now + WINDOW + 1,
      });
      await restarted.service.restore();
      should(restarted.service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
      should(restarted.service.quarantinedUntil(SESSION, ['000000000001'])).not.be.undefined();
      live.w.now += WINDOW + 1;
      should(live.service.quarantinedUntil(SESSION, ['dev'])).not.be.undefined();
      should(live.service.quarantinedUntil(SESSION, ['000000000001'])).not.be.undefined();
      finish();
      await delivering;
      should(live.service.quarantinedUntil(SESSION, ['dev'])).equal(live.w.now + WINDOW);
    });

    // R6-1
    it('should keep a successful delivery held, under every name, when the settlement could not be recorded and the daemon restarts', async () => {
      const live = await raised({ names: NAMES, quarantineBudget: 1 });
      const done = await live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
      const restarted = afterRestart(live);

      await restarted.service.restore();

      should(done.state).equal('delivered');
      should(live.w.events.at(-1)?.type).equal('surface.input_delivered');
      should(live.w.quarantineEvents.map(event => event.unresolved)).eql([true]);
      should(restarted.service.quarantinedUntil(SESSION, ['dev'])).equal(restarted.w.now + WINDOW);
      should(restarted.service.quarantinedUntil(SESSION, ['000000000001'])).equal(restarted.w.now + WINDOW);
      should(restarted.w.writes.length).equal(0);
    });

    // R6-1
    it('should keep an uncertain write held, under every name, when the settlement could not be recorded and the daemon restarts', async () => {
      const live = await raised({ names: NAMES, quarantineBudget: 1, typeResult: 'uncertain' });
      await refused(live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST));
      const restarted = afterRestart(live);

      await restarted.service.restore();

      should(restarted.service.quarantinedUntil(SESSION, ['dev'])).equal(restarted.w.now + WINDOW);
      should(restarted.service.quarantinedUntil(SESSION, ['000000000001'])).equal(restarted.w.now + WINDOW);
    });

    // R6-1
    it('should keep a delivery held after a restart when the pre-write step was delayed past the window and settlement was refused', async () => {
      const live = await raised({ names: NAMES, quarantineBudget: 1 });
      let open: () => void = () => undefined;
      live.w.gate = new Promise<void>(resolve => {
        open = resolve;
      });
      const delivering = live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
      await new Promise(resolve => setTimeout(resolve, 0));
      live.w.now += 3 * WINDOW;
      open();
      await delivering;
      const restarted = build({
        history: live.w.events,
        quarantineHistory: live.w.quarantineEvents,
        now: live.w.now + 1,
      });

      await restarted.service.restore();

      should(restarted.service.quarantinedUntil(SESSION, ['000000000001'])).equal(restarted.w.now + WINDOW);
    });

    // R6-2
    it('should hold every alias of an interrupted write, and no other terminal, while history and the agenda lookup stall', async () => {
      const live = await raised({ names: NAMES });
      live.w.gate = new Promise<void>(() => undefined);
      void live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
      await new Promise(resolve => setTimeout(resolve, 0));
      const stalled = build({
        history: live.w.events,
        quarantineHistory: live.w.quarantineEvents,
        historyGate: new Promise<void>(() => undefined),
        promptGate: new Promise<void>(() => undefined),
        now: live.w.now + 10 * WINDOW,
      });
      stalled.quarantine.lock();

      void stalled.service.restore();
      await new Promise(resolve => setTimeout(resolve, 0));

      should(stalled.service.quarantinedUntil(SESSION, ['dev'])).equal(stalled.w.now + WINDOW);
      should(stalled.service.quarantinedUntil(SESSION, ['000000000001'])).equal(stalled.w.now + WINDOW);
      should(stalled.service.quarantinedUntil(SESSION, ['unrelated'])).be.undefined();
      should(stalled.service.quarantinedUntil('x-1', ['dev'])).be.undefined();
    });

    // R6-2
    it('should keep the holds, under every alias, when reading the history fails', async () => {
      const live = await raised({ names: NAMES });
      live.w.gate = new Promise<void>(() => undefined);
      void live.service.deliver(SESSION, live.id, bodyFor(live.digest), HOST);
      await new Promise(resolve => setTimeout(resolve, 0));
      const broken = build({
        history: live.w.events,
        quarantineHistory: live.w.quarantineEvents,
        historyThrows: true,
        now: live.w.now + 10 * WINDOW,
      });
      broken.quarantine.lock();

      await broken.service.restore().catch(() => undefined);

      should(broken.service.quarantinedUntil(SESSION, ['dev'])).equal(broken.w.now + WINDOW);
      should(broken.service.quarantinedUntil(SESSION, ['000000000001'])).equal(broken.w.now + WINDOW);
      should(broken.service.quarantines(HOST, SESSION).map(entry => entry.key)).eql(['dev']);
    });

    // R6-3
    it('should journal only the holds the owner actually released, so a delivery in flight is still held after a restart', async () => {
      const first = await raised({ names: NAMES });
      await first.service.deliver(SESSION, first.id, bodyFor(first.digest), HOST);
      const { w, service } = first;
      w.now += 30_000;
      await service.raise(SESSION, RAISE);
      const [second] = await service.list(HOST);
      let open: () => void = () => undefined;
      w.gate = new Promise<void>(resolve => {
        open = resolve;
      });
      const delivering = service.deliver(SESSION, second?.id ?? '', bodyFor(second?.observedDigest ?? ''), HOST);
      await new Promise(resolve => setTimeout(resolve, 0));

      await service.endQuarantine(HOST, SESSION, 'dev');
      const ended = w.quarantineEvents.filter(event => event.type === ENDED);
      const restarted = build({
        history: w.events,
        quarantineHistory: w.quarantineEvents,
        now: w.now + 1,
      });
      await restarted.service.restore();
      open();
      await delivering;

      should(ended.length).equal(1);
      should(ended[0]?.hold).startWith(first.id);
      should(ended[0]?.hold).not.startWith(second?.id ?? 'x');
      should(restarted.service.quarantinedUntil(SESSION, ['dev'])).equal(restarted.w.now + WINDOW);
      should(restarted.service.quarantinedUntil(SESSION, ['000000000001'])).equal(restarted.w.now + WINDOW);
    });
  });

  it('should let go of a session that ended', async () => {
    const { w, service, quarantine, id, digest } = await raised();
    await service.deliver(SESSION, id, bodyFor(digest), HOST);
    w.sessions = [];
    await service.sweep();

    should(quarantine.sessions()).eql([]);
  });
});

describe('when the terminal changes under the card (#B100)', () => {
  /** The same sudo prompt, redrawn: the program printed it again a row lower (a resize, a retry, a clear). */
  const REDRAWN: InputTargetFacts = { ...FACTS, cursorRow: 4 };

  it('should redraw the card for the same prompt redrawn a row lower, count nothing, and type once into it', async () => {
    const { w, service, id, digest } = await raised();
    w.facts = REDRAWN;

    const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    const [card] = await service.list(HOST);
    const done = await service.deliver(SESSION, id, bodyFor(card?.observedDigest ?? ''), HOST);

    should(error.code).equal('conflict');
    should(error.reason).equal('target_rebound');
    should(error.message).containEql('same prompt');
    should(card?.state).equal('pending');
    should(card?.observedDigest).equal(digestFacts(REDRAWN));
    should(card?.observedDigest).not.equal(digest);
    should(card?.observed).eql(REDRAWN);
    should(w.audits.map(entry => entry.event)).eql(['input.requested', 'input.rebound', 'input.delivered']);
    should(done.state).equal('delivered');
    should(w.writes).eql([{ text: VALUE, submit: true }]);
  });

  it('should never count a redraw as a failed check, however many come before the Send that lands', async () => {
    const { w, service, id } = await raised();
    let digest = '';
    for (let row = 2; row < 2 + INPUT_MAX_REBINDS; row += 1) {
      w.facts = { ...FACTS, cursorRow: row };
      const [card] = await service.list(HOST);
      const error = await refused(service.deliver(SESSION, id, bodyFor(card?.observedDigest ?? ''), HOST));
      should(error.reason).equal('target_rebound');
      digest = (await service.list(HOST))[0]?.observedDigest ?? '';
    }

    should(w.audits.filter(entry => entry.event === 'input.refused')).eql([]);
    should((await service.deliver(SESSION, id, bodyFor(digest), HOST)).state).equal('delivered');
  });

  it('should end, in plain words, a terminal that keeps redrawing faster than the owner can answer', async () => {
    const { w, service, id } = await raised();
    const reasons: (string | undefined)[] = [];
    for (let row = 2; row < 3 + INPUT_MAX_REBINDS; row += 1) {
      w.facts = { ...FACTS, cursorRow: row };
      const [card] = await service.list(HOST);
      reasons.push((await refused(service.deliver(SESSION, id, bodyFor(card?.observedDigest ?? ''), HOST))).reason);
    }

    should(reasons).eql([...Array.from({ length: INPUT_MAX_REBINDS }, () => 'target_rebound'), 'target_unsettled']);
    should(await service.list(HOST)).eql([]);
    should(w.closed.at(-1)?.note).equal(
      'The terminal kept changing, so nothing was typed. Ask the ferret to request again.',
    );
    should(w.writes).eql([]);
  });

  const different: readonly [string, InputTargetFacts][] = [
    ['another program', ANOTHER_PROGRAM],
    [
      'the same program run again',
      { ...FACTS, cursorRow: 4, foreground: { ...FACTS.foreground, pid: 5200, pgid: 5200 } },
    ],
    ['another prompt', { ...FACTS, cursorRow: 4, promptLine: 'Password:', promptLineDigest: 'b'.repeat(64) }],
    ['echo on', { ...FACTS, cursorRow: 4, echo: 'on' }],
    ['another pane', { ...FACTS, cursorRow: 4, paneProof: { ...FACTS.paneProof, paneId: '%9' } }],
  ];
  for (const [name, facts] of different) {
    it(`should refuse and count it when the terminal now shows ${name}, typing nothing`, async () => {
      const { w, service, id, digest } = await raised();
      w.facts = facts;
      const error = await refused(service.deliver(SESSION, id, bodyFor(digest), HOST));

      should(error.reason).equal('target_changed');
      should(w.audits.at(-1)?.event).equal('input.refused');
      should((await service.list(HOST))[0]?.observedDigest).equal(digest);
      should(w.writes).eql([]);
    });
  }

  it('should redraw the card, not type again, when the guarded write refused because the prompt moved', async () => {
    const { w, service, id, digest } = await raised({ typeResult: 'target_changed' });
    let write: () => void = () => undefined;
    w.gate = new Promise<void>(resolve => {
      write = resolve;
    });
    const sending = refused(service.deliver(SESSION, id, bodyFor(digest), HOST));
    await new Promise(resolve => setTimeout(resolve, 0));
    w.facts = REDRAWN;
    write();
    const error = await sending;

    should(error.reason).equal('target_rebound');
    should(w.writes.length).equal(1);
    should((await service.list(HOST))[0]?.observedDigest).equal(digestFacts(REDRAWN));
    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
  });
});

describe('a one-time code (`code`): visible, never locked, never masked when the owner typed it', () => {
  const CODE: InputRaise = { ...RAISE, prompt: 'The bastion wants the 2FA code', sensitivity: 'code' };
  /** An OTP prompt that shows what is typed: ssh's keyboard-interactive "Verification code:" with echo on. */
  const OTP: InputTargetFacts = {
    ...FACTS,
    foreground: { ...FACTS.foreground, comm: 'ssh', argv: 'ssh bastion' },
    program: 'ssh',
    echo: 'on',
    promptLine: 'Verification code:',
  } as InputTargetFacts;

  it('should raise a card that says the ferret can see the code, flagged neutral, with no lock and no ping', async () => {
    // Act
    const { w, view, request } = await raised({ facts: OTP }, CODE);

    // Assert
    should(request.sensitivity).equal('code');
    should(request.risk).eql({ level: 'neutral', reason: 'One-time code: the ferret can see it.' });
    should(request.fields[0]).containDeep({ label: 'Code', sensitivity: 'code' });
    should(request.lock).be.undefined();
    should(view.lockSeconds).be.undefined();
    should(w.cards[0]?.title).equal('Needs a code');
    should(w.cards[0]?.ask).equal('Type it into the terminal. One-time code: the ferret can see this value.');
    should(w.cards[0]?.blocking).be.false();
  });

  it('should type the code with no quarantine and keep it out of the redaction window', async () => {
    // Arrange
    const { w, service, values, id, digest } = await raised({ facts: OTP }, CODE);

    // Act
    const done = await service.deliver(SESSION, id, bodyFor(digest), HOST);

    // Assert — the ferret may read it straight away, as the card said.
    should(done.state).equal('delivered');
    should(w.writes).eql([{ text: VALUE, submit: true }]);
    should(values.scrub(SESSION, `screen: ${VALUE}`)).equal(`screen: ${VALUE}`);
    should(w.quarantineEvents.length).equal(0);
    should(service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
  });

  it('should still refuse a code that would press keys', async () => {
    // Arrange
    const { service, id, digest } = await raised({ facts: OTP }, CODE);

    // Act
    const error = await refused(service.deliver(SESSION, id, bodyFor(digest, {}, '12\n34'), HOST));

    // Assert
    should(error.code).equal('bad_request');
  });

  it('should leave the typing gate open for a card of codes only, and closed for any other card', async () => {
    // Arrange
    const code = await raised({ facts: OTP }, CODE);
    const secret = await raised({}, RAISE);
    const at = { kind: 'terminal', key: 'dev' } as const;

    // Act / Assert — the ferret may type a code it read itself; the card stays findable for input.wait.
    should(code.service.pendingOn(SESSION, at, { typing: true })).be.undefined();
    should(code.service.pendingOn(SESSION, at)).equal('A1');
    should(secret.service.pendingOn(SESSION, at, { typing: true })).equal('A1');
  });

  // Review M1: the ferret's word "code" never makes a password visible to it.
  for (const [what, facts] of [
    ['a sudo prompt with typing hidden', FACTS],
    [
      'a shell faking a sudo prompt with typing shown',
      {
        ...FACTS,
        foreground: { ...FACTS.foreground, comm: 'bash', argv: 'bash' },
        program: 'bash',
        echo: 'on',
        recognisedConsumer: false,
      } as InputTargetFacts,
    ],
    ['a PIN prompt with typing hidden', { ...OTP, echo: 'off', promptLine: 'Enter PIN:' } as InputTargetFacts],
  ] as const)
    it(`should handle a code aimed at ${what} as a secret, end to end`, async () => {
      // Arrange
      const { w, service, values, view, request, id, digest } = await raised({ facts }, CODE);

      // Act
      const gate = service.pendingOn(SESSION, { kind: 'terminal', key: 'dev' }, { typing: true });
      await service.deliver(SESSION, id, bodyFor(digest), HOST);

      // Assert — hidden on the card, said so, locked, blocking, masked, and journalled as a secret.
      should(request.sensitivity).equal('secret');
      should(request.fields[0]?.sensitivity).equal('secret');
      should(request.risk).eql({ level: 'amber', reason: 'Treated as a secret: this is a password field.' });
      should(view.lockSeconds).be.above(0);
      should(w.cards[0]?.title).equal('Needs a secret');
      should(w.cards[0]?.blocking).be.true();
      should(gate).equal('A1');
      should(values.scrub(SESSION, VALUE)).equal('[redacted:input A1]');
      should(w.quarantineEvents.length).be.above(0);
      should(w.events.map(event => event.sensitivity)).containEql('secret');
      should(w.events.map(event => event.sensitivity)).not.containEql('code');
      should(w.audits.map(entry => entry.detail.sensitivity)).not.containEql('code');
    });

  it('should treat a code as a secret when the ferret itself says password or PIN: its words may only raise', async () => {
    // Act
    const prompt = await raised({ facts: OTP }, { ...CODE, prompt: 'sudo needs your password' });
    const label = await raised(
      { facts: OTP },
      { ...RAISE, prompt: 'the card wants it', fields: [{ id: 'value', label: 'Card PIN', sensitivity: 'code' }] },
    );

    const hidden = await raised({ facts: OTP }, { ...CODE, prompt: 'sudo needs your pass\u200bword' });
    const lookalike = await raised({ facts: OTP }, { ...CODE, prompt: 'sudo needs your p\u0430ssword' });

    // Assert
    should(prompt.request.sensitivity).equal('secret');
    should(label.request.sensitivity).equal('secret');
    should(hidden.request.sensitivity).equal('secret');
    should(lookalike.request.sensitivity).equal('secret');
  });

  it('should keep a code at an OTP prompt with typing hidden only from a code program it proved', async () => {
    // Act — the same echo-off "Verification code:" line, from a real ssh and from a shell renamed "ssh".
    const proved = await raised({ facts: { ...OTP, echo: 'off' } as InputTargetFacts, codeProgram: true }, CODE);
    const renamed = await raised({ facts: { ...OTP, echo: 'off' } as InputTargetFacts }, CODE);

    // Assert
    should(proved.request.sensitivity).equal('code');
    should(proved.request.lock).be.undefined();
    should(renamed.request.sensitivity).equal('secret');
  });

  it('should check again when a restarted daemon finds the terminal now asking for a password, never back', async () => {
    // Arrange — raised at an OTP prompt; the daemon restarts and the pane now shows a sudo prompt.
    const first = await raised({ facts: OTP }, CODE);
    const second = build({ history: [...first.w.events], facts: FACTS });

    // Act
    await second.service.restore();
    const [back] = await second.service.list(HOST);
    await second.service.deliver(SESSION, back?.id ?? '', bodyFor(back?.observedDigest ?? ''), HOST);

    // Assert
    should(back?.sensitivity).equal('secret');
    should(back?.fields[0]?.risk?.reason).equal('Treated as a secret: this is a password field.');
    should(second.w.quarantineEvents.length).be.above(0);
  });
});

describe('what a request push is about', () => {
  it('should call a pending code card a one-time code, and every other card, or a settled one, other', async () => {
    // Arrange
    const otp = {
      ...FACTS,
      foreground: { ...FACTS.foreground, comm: 'ssh' },
      program: 'ssh',
      echo: 'on',
      promptLine: 'Verification code:',
    } as InputTargetFacts;
    const code = await raised({ facts: otp }, { ...RAISE, prompt: 'the 2FA code', sensitivity: 'code' });
    const secret = await raised({}, RAISE);

    // Act / Assert
    should(code.service.pushSubjectOf(SESSION, code.id)).equal('one-time-code');
    should(code.service.pushSubjectOf('another-session', code.id)).equal('other');
    should(secret.service.pushSubjectOf(SESSION, secret.id)).equal('other');
    await code.service.cancel(SESSION, code.id, HOST);
    should(code.service.pushSubjectOf(SESSION, code.id)).equal('other');
  });
});
