import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputEvent,
  type InputRaise,
  type InputTarget,
  type InputTargetFacts,
  type LoginEntrySummary,
  type LoginFieldRole,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputRequestError } from '../../../src/lib/input-requests/errors.ts';
import type {
  InputCaller,
  InputCard,
  InputFieldValue,
  InputLoginPort,
  InputTargetField,
  ObserveResult,
} from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { InputTargetRouter } from '../../../src/lib/input-requests/target-router.ts';
import { FACTS } from './support.ts';

/**
 * P2, A CARD OF SEVERAL FIELDS: one card for one surface, each field with its own sensitivity and element, typed
 * by the daemon in one write. The page here is a FAKE port; the real browser adapter comes with the browser PR.
 */

const SESSION = 'mvv6b4qw-49d0158d';
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const EMAIL = 'kirin@example.com';
const PASSWORD = 'hunter2-UNIQUE-pw';

type PageFacts = Extract<InputTargetFacts, { readonly kind: 'browser' }>;
type PageField = PageFacts['fields'][number];

const pageField = (fieldId: string, over: Partial<PageField> = {}): PageField => ({
  fieldId,
  frameOrigin: 'https://accounts.google.com',
  frameId: 'main',
  backendNodeId: fieldId === 'email' ? 11 : 12,
  field:
    fieldId === 'email'
      ? { tag: 'input', type: 'email', autocomplete: 'username' }
      : { tag: 'input', type: 'password', autocomplete: 'current-password' },
  box: { x: 10, y: 10, w: 300, h: 40 },
  visible: true,
  ...over,
});

const PAGE: PageFacts = {
  kind: 'browser',
  pageId: 'page-1',
  origin: 'https://accounts.google.com',
  secure: true,
  navigationId: 'loader-1',
  fields: [pageField('email'), pageField('password')],
};

const LOGIN: InputRaise = {
  target: { kind: 'browser', key: 'app' },
  prompt: 'Google login for the deploy console',
  fields: [
    { id: 'email', label: 'Email', sensitivity: 'plain', element: { kind: 'selector', selector: '#identifierId' } },
    { id: 'password', sensitivity: 'secret', element: { kind: 'ref', ref: 'e12' } },
  ],
  submit: 'offer-owner',
};

interface Writes {
  readonly target: InputTarget;
  readonly values: readonly InputFieldValue[];
  readonly submit: boolean;
}

function build(options: { facts?: InputTargetFacts; entries?: LoginEntrySummary[]; history?: InputEvent[] } = {}) {
  const writes: Writes[] = [];
  const observed: (readonly InputTargetField[])[] = [];
  const closed: AgendaId[] = [];
  const cards: InputCard[] = [];
  const told: string[] = [];
  const fills: { id: string; role: LoginFieldRole }[] = [];
  const saves: { entry: string; label: string; match: string | undefined; fields: object }[] = [];
  const kept: string[] = [];
  let facts: InputTargetFacts | undefined = options.facts ?? PAGE;
  /** What looking for the fields again finds; the page as it is now when unset. */
  let refound: ObserveResult | undefined;
  const refinds: InputTargetFacts[] = [];
  const shots: InputTargetFacts[] = [];
  const typedInto: InputTargetFacts[] = [];
  let card = 1;
  let id = 1;
  const clock = { now: () => Date.parse('2026-10-31T12:00:00.000Z') };
  const values = new EphemeralValues(clock);
  const logins: InputLoginPort = {
    entries: async () => options.entries ?? [],
    fill: async (entry, role) => {
      fills.push({ id: entry, role });
      return role === 'username' ? EMAIL : PASSWORD;
    },
    save: async (entry, label, match, fields) => void saves.push({ entry, label, match, fields }),
  };
  const page = {
    observe: async (_session: string, _target: InputTarget, fields: readonly InputTargetField[]) => {
      observed.push(fields);
      return (
        facts === undefined ? { ok: false, reason: 'target_gone' } : { ok: true, facts, names: ['page-1'] }
      ) as ObserveResult;
    },
    refind: async (
      _session: string,
      _target: InputTarget,
      _fields: readonly InputTargetField[],
      expected: InputTargetFacts,
    ) => {
      refinds.push(expected);
      return (refound ??
        (facts === undefined
          ? { ok: false, reason: 'target_gone' }
          : { ok: true, facts, names: ['page-1'] })) as ObserveResult;
    },
    shoot: async (_session: string, _target: InputTarget, seen: InputTargetFacts) => {
      shots.push(seen);
      return { pngBase64: `c2hvdA${shots.length}`, clip: { x: 0, y: 0, w: 400, h: 200 } };
    },
    type: async (
      _session: string,
      target: InputTarget,
      typed: readonly InputFieldValue[],
      submit: boolean,
      expected: InputTargetFacts,
    ) => {
      writes.push({ target, values: typed, submit });
      typedInto.push(expected);
      return 'typed' as const;
    },
  };
  const terminal = {
    observe: async () => ({ ok: true, facts: FACTS }) as ObserveResult,
    type: async (_session: string, target: InputTarget, text: string, submit: boolean) => {
      writes.push({ target, values: [{ field: 'value', text }], submit });
      return 'typed' as const;
    },
  };
  const service = new InputRequestService({
    target: new InputTargetRouter(terminal, page),
    agenda: {
      raise: async (_session, raised) => {
        cards.push(raised);
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, cardId) => void closed.push(cardId),
      promptOf: async () => 'Google login for the deploy console',
    },
    notifier: { tell: async (_session, _id, message) => void told.push(message) },
    journal: {
      publish: async () => undefined,
      history: async () => options.history ?? [],
      quarantine: async () => undefined,
      quarantines: async () => [],
    },
    audit: {
      record: async () => undefined,
      saved: async entry => void kept.push(entry.field),
      stored: async () => undefined,
    },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== SESSION, all: async () => [SESSION] },
    values,
    quarantine: new QuarantineRegistry(clock),
    redact: async text => values.scrubAll(text),
    logins,
  });
  return {
    service,
    writes,
    observed,
    cards,
    closed,
    told,
    fills,
    saves,
    kept,
    values,
    refinds,
    shots,
    typedInto,
    setFacts: (next: InputTargetFacts | undefined) => {
      facts = next;
    },
    setRefound: (next: ObserveResult | undefined) => {
      refound = next;
    },
  };
}

async function raisedLogin(options: Parameters<typeof build>[0] = {}, raise: InputRaise = LOGIN) {
  const built = build(options);
  const view = await built.service.raise(SESSION, raise);
  const [request] = await built.service.list(HOST);
  if (request === undefined) throw new Error('no request');
  return { ...built, view, request };
}

const send = (digest: string, over: Partial<InputDeliverBody> = {}): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  submit: true,
  ...over,
});

/** A Send of the login card's two typed values. */
const both = (digest: string): InputDeliverBody =>
  send(digest, {
    fields: [
      { field: 'email', padded: padInputValue(EMAIL) },
      { field: 'password', padded: padInputValue(PASSWORD) },
    ],
  });

const refused = async (promise: Promise<unknown>): Promise<InputRequestError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InputRequestError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('a card of several fields', () => {
  it('should hold every field with its own sensitivity and flag, the plain one red', async () => {
    const { request } = await raisedLogin();

    should(request.sensitivity).equal('secret');
    should(request.fields.map(field => [field.id, field.label, field.sensitivity, field.risk?.level])).eql([
      ['email', 'Email', 'plain', 'red'],
      ['password', 'Password', 'secret', 'green'],
    ]);
    should(request.fields[0]?.risk?.reason).equal('Not secret: the ferret can see this value.');
    should(request.risk?.level).equal('red');
    should(request.fields[1]?.element).eql({ kind: 'ref', ref: 'e12' });
  });

  it('should hand the target the field pointers, and word the card as a login', async () => {
    const built = build();

    await built.service.raise(SESSION, LOGIN);
    const [raisedCard] = built.cards;

    should(built.observed[0]).eql([
      { id: 'email', element: { kind: 'selector', selector: '#identifierId' } },
      { id: 'password', element: { kind: 'ref', ref: 'e12' } },
    ]);
    should(raisedCard?.title).equal('Needs a login');
    should(raisedCard?.ask).equal('Type them into the page. Not secret: the ferret can see this value.');
  });

  it('should type every field in one write, in order, and mask only the values that are not plain', async () => {
    const { service, request, writes, values } = await raisedLogin();

    const result = await service.deliver(
      SESSION,
      request.id,
      send(request.observedDigest ?? '', {
        fields: [
          { field: 'password', padded: padInputValue(PASSWORD) },
          { field: 'email', padded: padInputValue(EMAIL) },
        ],
      }),
      HOST,
    );

    should(result.state).equal('delivered');
    should(writes).eql([
      {
        target: { kind: 'browser', key: 'app' },
        values: [
          { field: 'email', text: EMAIL },
          { field: 'password', text: PASSWORD },
        ],
        submit: true,
      },
    ]);
    should(values.scrub(SESSION, `${EMAIL} ${PASSWORD}`)).not.containEql(PASSWORD);
    should(values.scrub(SESSION, `${EMAIL} ${PASSWORD}`)).containEql(EMAIL);
  });

  it('should refuse a Send that leaves a field empty, names a field the card lacks, or sends one bare value', async () => {
    const { service, request, writes } = await raisedLogin();
    const digest = request.observedDigest ?? '';

    const missing = await refused(
      service.deliver(
        SESSION,
        request.id,
        send(digest, { fields: [{ field: 'email', padded: padInputValue(EMAIL) }] }),
        HOST,
      ),
    );
    const unknown = await refused(
      service.deliver(
        SESSION,
        request.id,
        send(digest, {
          fields: [
            { field: 'email', padded: padInputValue(EMAIL) },
            { field: 'otp', padded: padInputValue('123456') },
          ],
        }),
        HOST,
      ),
    );
    const bare = await refused(
      service.deliver(SESSION, request.id, send(digest, { padded: padInputValue(EMAIL) }), HOST),
    );

    should(missing.message).equal('fill every field before Send: password is empty');
    should(unknown.message).equal('that field is not on this card');
    should(bare.message).equal('this card asks for several values: send each by its field');
    should(writes).eql([]);
  });

  it('should check each value against its own field: a line break is refused in the secret, a Tab allowed in the plain', async () => {
    const { service, request, writes } = await raisedLogin();
    const digest = request.observedDigest ?? '';

    const broken = await refused(
      service.deliver(
        SESSION,
        request.id,
        send(digest, {
          fields: [
            { field: 'email', padded: padInputValue(EMAIL) },
            { field: 'password', padded: padInputValue('pass\nword') },
          ],
        }),
        HOST,
      ),
    );
    await service.deliver(
      SESSION,
      request.id,
      send(digest, {
        fields: [
          { field: 'email', padded: padInputValue(`a\t${EMAIL}`) },
          { field: 'password', padded: padInputValue(PASSWORD) },
        ],
      }),
      HOST,
    );

    should(broken.message).containEql('this would press keys');
    should(writes.length).equal(1);
  });

  it('should fill the fields not typed from one saved login, each by its role', async () => {
    const { service, request, writes, fills } = await raisedLogin();

    await service.deliver(
      SESSION,
      request.id,
      send(request.observedDigest ?? '', {
        fields: [{ field: 'email', padded: padInputValue('other@example.com') }],
        entry: 'GOOGLE_COM',
      }),
      HOST,
    );
    const second = await raisedLogin();
    await second.service.deliver(
      SESSION,
      second.request.id,
      send(second.request.observedDigest ?? '', { entry: 'GOOGLE_COM' }),
      HOST,
    );

    should(fills).eql([{ id: 'GOOGLE_COM', role: 'password' }]);
    should(writes[0]?.values).eql([
      { field: 'email', text: 'other@example.com' },
      { field: 'password', text: PASSWORD },
    ]);
    should(second.fills).eql([
      { id: 'GOOGLE_COM', role: 'username' },
      { id: 'GOOGLE_COM', role: 'password' },
    ]);
  });

  it('should offer only saved logins that hold every field, and suggest saving the card as one login', async () => {
    const entry = (id: string, username: string | undefined): LoginEntrySummary => ({
      id,
      label: id.toLowerCase(),
      match: ['accounts.google.com'],
      ...(username === undefined ? {} : { username }),
      fields: { password: true, totp: false },
      createdAt: 'a',
      updatedAt: 'a',
    });
    const { request } = await raisedLogin({
      entries: [entry('GOOGLE_COM', 'kirin'), entry('PASSWORD_ONLY', undefined)],
    });

    should(request.saved?.offers.map(offer => [offer.id, offer.matched])).eql([['GOOGLE_COM', true]]);
    should(request.saved?.suggest).eql({ id: 'GOOGLE_COM', label: 'google_com' });
    should(request.saved?.saves).equal('password');
  });

  it('should refuse a terminal card of two fields and a terminal field that names an element', async () => {
    const { service } = build();
    const terminal: InputTarget = { kind: 'terminal', key: 'dev' };

    const two = await refused(
      service.raise(SESSION, {
        ...LOGIN,
        target: terminal,
        fields: [
          { id: 'user', sensitivity: 'plain' },
          { id: 'password', sensitivity: 'secret' },
        ],
      }),
    );
    const pointed = await refused(
      service.raise(SESSION, {
        ...LOGIN,
        target: terminal,
        fields: [{ id: 'password', sensitivity: 'secret', element: { kind: 'selector', selector: '#pw' } }],
      }),
    );

    should(two.message).equal(
      'a terminal shows one prompt at a time: ask for one value, then raise the next with chain',
    );
    should(pointed.message).equal('a terminal field names no element: the value goes to its prompt');
  });

  it('should label a terminal value as the agent asked, and type it as one value', async () => {
    const { service, writes } = build();
    await service.raise(SESSION, {
      target: { kind: 'terminal', key: 'dev' },
      prompt: 'the key passphrase',
      fields: [{ id: 'value', label: 'Passphrase', sensitivity: 'secret' }],
      submit: 'owner-default',
    });
    const [request] = await service.list(HOST);
    if (request === undefined) throw new Error('no request');

    await service.deliver(
      SESSION,
      request.id,
      send(request.observedDigest ?? '', { padded: padInputValue(PASSWORD) }),
      HOST,
    );

    should(request.fields[0]?.label).equal('Passphrase');
    should(writes[0]?.values).eql([{ field: 'value', text: PASSWORD }]);
  });

  it('should count the steps of a chained login', async () => {
    const { service } = build();
    await service.raise(SESSION, LOGIN);
    await service.raise(SESSION, {
      ...LOGIN,
      target: { kind: 'browser', key: 'two' },
      fields: [{ id: 'code', sensitivity: 'private', element: { kind: 'ref', ref: 'e3' } }],
      chain: 'A1' as AgendaId,
    });
    await service.raise(SESSION, {
      ...LOGIN,
      target: { kind: 'browser', key: 'three' },
      chain: 'A2' as AgendaId,
    });
    const requests = await service.list(HOST);

    should(requests.map(request => [request.chain, request.step])).eql([
      [undefined, undefined],
      ['A1', 2],
      ['A2', 3],
    ]);
  });

  it('should flag a page that is not https, a field in another site’s frame, a secret in a plain box and a hidden field', async () => {
    const cases: [PageFacts, string][] = [
      [{ ...PAGE, secure: false }, 'The page is not https, so the value crosses the network unencrypted.'],
      [
        { ...PAGE, fields: [pageField('email'), pageField('password', { frameOrigin: 'https://evil.example' })] },
        'This field is inside a frame from another site, not the page itself.',
      ],
      [
        { ...PAGE, fields: [pageField('email'), pageField('password', { field: { tag: 'input', type: 'text' } })] },
        'This is not a password field, so the value will show on the page.',
      ],
      [
        { ...PAGE, fields: [pageField('email'), pageField('password', { visible: false })] },
        'Ferretry could not see this field on the page, so the value may land somewhere unexpected.',
      ],
      [
        { ...PAGE, fields: [pageField('email'), pageField('password', { covered: true })] },
        'Something on the page covers this field, or it is off screen, so you cannot see where the value goes.',
      ],
    ];
    for (const [facts, reason] of cases) {
      const { request } = await raisedLogin({ facts });

      should(request.fields[1]?.risk).eql({ level: 'amber', reason });
    }
  });

  it('should tell the agent to hand a captcha to the owner, never to solve it', async () => {
    const { view } = await raisedLogin({ facts: { ...PAGE, challenge: { provider: 'recaptcha' } } });

    should(view.observed).eql({ consumer: 'accounts.google.com' });
    should(view.note).containEql('browser_ask_owner');
    should(view.note).containEql('never try to solve it');
  });

  it('should refuse a Send when a field became another kind of field since the card was drawn, typing nothing', async () => {
    const { service, request, writes, setFacts } = await raisedLogin();
    setFacts({
      ...PAGE,
      fields: [pageField('email'), pageField('password', { field: { tag: 'input', type: 'text' } })],
    });

    const error = await refused(service.deliver(SESSION, request.id, both(request.observedDigest ?? ''), HOST));

    should(error.message).equal('what is on the page is no longer what the card showed; nothing was typed');
    should(writes).eql([]);
  });

  it('should end a page’s card after a restart instead of holding it with no way to send', async () => {
    const history: InputEvent[] = [
      {
        type: 'surface.input_requested',
        requestId: 'f'.repeat(32),
        agendaItemId: 'A4' as AgendaId,
        sessionId: SESSION,
        target: { kind: 'browser', key: 'app' },
        sensitivity: 'secret',
        submit: 'offer-owner',
        state: 'pending',
        expiresAt: '2026-10-31T12:05:00.000Z',
        at: '2026-10-31T11:59:00.000Z',
      },
    ];
    const { service, closed, told, writes } = build({ history });

    await service.restore();

    should(await service.list(HOST)).eql([]);
    should(closed).eql(['A4']);
    should(told[0]).containEql('browser_request_input');
    should(writes).eql([]);
  });
});

describe('InputTargetRouter', () => {
  const terminalWrites: string[] = [];
  const terminal = {
    observe: async () => ({ ok: true, facts: FACTS }) as ObserveResult,
    type: async (_session: string, _target: InputTarget, text: string) => {
      terminalWrites.push(text);
      return 'typed' as const;
    },
  };

  it('should say a page cannot take a request when no browser adapter is wired', async () => {
    const router = new InputTargetRouter(terminal);

    should(await router.observe(SESSION, { kind: 'browser', key: 'app' }, [{ id: 'value' }])).eql({
      ok: false,
      reason: 'unsupported',
    });
    should(await router.type(SESSION, { kind: 'browser', key: 'app' }, [], false, PAGE)).equal('target_gone');
    should(await router.refind(SESSION, { kind: 'browser', key: 'app' }, [{ id: 'value' }], PAGE)).eql({
      ok: false,
      reason: 'unsupported',
    });
  });

  it("should send a page's re-find to the browser, and look at a terminal again (#B100)", async () => {
    const asked: InputTargetFacts[] = [];
    const page = {
      observe: async () => ({ ok: false, reason: 'target_gone' }) as ObserveResult,
      type: async () => 'typed' as const,
    };
    const finder = {
      ...page,
      refind: async (_s: string, _t: InputTarget, _f: readonly InputTargetField[], expected: InputTargetFacts) => {
        asked.push(expected);
        return { ok: true, facts: PAGE } as ObserveResult;
      },
    };
    const app = { kind: 'browser', key: 'app' } as const;

    should(await new InputTargetRouter(terminal, page).refind(SESSION, app, [{ id: 'value' }], PAGE)).eql({
      ok: false,
      reason: 'unsupported',
    });
    should(await new InputTargetRouter(terminal, finder).refind(SESSION, app, [{ id: 'value' }], PAGE)).eql({
      ok: true,
      facts: PAGE,
    });
    should(asked).eql([PAGE]);
    should(
      await new InputTargetRouter(terminal).refind(SESSION, { kind: 'terminal', key: 'dev' }, [{ id: 'value' }], FACTS),
    ).eql({ ok: true, facts: FACTS });
  });

  it('should type exactly one value into a terminal and refuse any other count with nothing typed', async () => {
    const router = new InputTargetRouter(terminal);
    const dev: InputTarget = { kind: 'terminal', key: 'dev' };

    should(await router.type(SESSION, dev, [], true, FACTS)).equal('target_changed');
    should(
      await router.type(
        SESSION,
        dev,
        [
          { field: 'a', text: 'one' },
          { field: 'b', text: 'two' },
        ],
        true,
        FACTS,
      ),
    ).equal('target_changed');
    should(await router.type(SESSION, dev, [{ field: 'value', text: 'only' }], true, FACTS)).equal('typed');
    should(terminalWrites).eql(['only']);
  });
});

describe('review regressions: a card of several fields', () => {
  it('should keep a visible text field amber for a secret even when autocomplete says it is for a password', async () => {
    for (const autocomplete of ['current-password', 'new-password']) {
      const facts: PageFacts = {
        ...PAGE,
        fields: [pageField('email'), pageField('password', { field: { tag: 'input', type: 'text', autocomplete } })],
      };
      const { request } = await raisedLogin({ facts });

      should(request.fields[1]?.risk).eql({
        level: 'amber',
        reason: 'This is not a password field, so the value will show on the page.',
      });
    }
  });

  it('should refuse a chain to a card that is not one of this session’s input requests', async () => {
    const { service } = build();
    const unknown = await refused(service.raise(SESSION, { ...LOGIN, chain: 'A9' as AgendaId }));
    await service.raise(SESSION, LOGIN);
    // A1 is this session's card; another session may not claim to continue it.
    const foreign = await refused(service.raise('mvv6b4qw-0000other', { ...LOGIN, chain: 'A1' as AgendaId }));

    should(unknown.message).equal(
      'chain names A9, which is not an input request of this session; raise this card without chain',
    );
    should(foreign.code).equal('bad_request');
    should(await service.list(HOST)).have.length(1);
  });

  it('should name a page whose origin is opaque by what the browser said', async () => {
    const { view } = await raisedLogin({ facts: { ...PAGE, origin: 'null' } });

    should(view.observed).eql({ consumer: 'null' });
  });

  it('should refuse a saved login beside a Send that already typed every field', async () => {
    const { service, request, writes, fills } = await raisedLogin();

    const error = await refused(
      service.deliver(
        SESSION,
        request.id,
        send(request.observedDigest ?? '', {
          fields: [
            { field: 'email', padded: padInputValue(EMAIL) },
            { field: 'password', padded: padInputValue(PASSWORD) },
          ],
          entry: 'GOOGLE_COM',
        }),
        HOST,
      ),
    );

    should(error.message).equal('every field was typed, so there is nothing for the saved login to fill');
    should(writes).eql([]);
    should(fills).eql([]);
  });
});

describe('Save as on a login card', () => {
  const both = (email = EMAIL, password = PASSWORD) => [
    { field: 'email', padded: padInputValue(email) },
    { field: 'password', padded: padInputValue(password) },
  ];

  it('should keep the username and the password together in ONE save, and record one kept field each', async () => {
    const { service, request, saves, kept, writes } = await raisedLogin();

    const result = await service.deliver(
      SESSION,
      request.id,
      send(request.observedDigest ?? '', { fields: both(), save: { entry: 'GOOGLE_COM', label: 'Google' } }),
      HOST,
    );

    should(result.saved).eql({ entry: 'GOOGLE_COM', ok: true });
    should(saves).eql([
      {
        entry: 'GOOGLE_COM',
        label: 'Google',
        match: 'accounts.google.com',
        fields: { username: EMAIL, password: PASSWORD },
      },
    ]);
    should(kept).eql(['username', 'password']);
    should(writes.length).equal(1);
  });

  it('should refuse the whole Send before typing when a kept password is too short or a field was not typed', async () => {
    const short = await raisedLogin();
    const tooShort = await refused(
      short.service.deliver(
        SESSION,
        short.request.id,
        send(short.request.observedDigest ?? '', {
          fields: both(EMAIL, 'abc'),
          save: { entry: 'GOOGLE_COM', label: 'Google' },
        }),
        HOST,
      ),
    );
    const part = await raisedLogin();
    const partly = await refused(
      part.service.deliver(
        SESSION,
        part.request.id,
        send(part.request.observedDigest ?? '', {
          fields: [{ field: 'email', padded: padInputValue(EMAIL) }],
          save: { entry: 'GOOGLE_COM', label: 'Google' },
        }),
        HOST,
      ),
    );

    should(tooShort.message).containEql('a saved password is at least');
    should(partly.code).equal('bad_request');
    should([...short.writes, ...part.writes, ...short.saves, ...part.saves]).eql([]);
  });

  it('should refuse to keep a value a saved login filled, even from a caller that skipped the schema', async () => {
    const { service, request, writes, saves } = await raisedLogin();

    // The wire refuses `save` beside `entry`; the service holds the same line for a caller that never parsed it.
    const error = await refused(
      service.deliver(
        SESSION,
        request.id,
        send(request.observedDigest ?? '', {
          fields: [{ field: 'email', padded: padInputValue(EMAIL) }],
          entry: 'GOOGLE_COM',
          save: { entry: 'GOOGLE_COM', label: 'Google' },
        }),
        HOST,
      ),
    );

    should(error.message).equal(
      'Save as keeps the values you typed: type every field it keeps, or send without saving',
    );
    should([...writes, ...saves]).eql([]);
  });

  it('should refuse to keep a card of two passwords as one login', async () => {
    const { service, request, writes } = await raisedLogin(
      {},
      {
        ...LOGIN,
        fields: [
          { id: 'old', sensitivity: 'secret', element: { kind: 'ref', ref: 'e1' } },
          { id: 'password', sensitivity: 'secret', element: { kind: 'ref', ref: 'e2' } },
        ],
      },
    );

    const error = await refused(
      service.deliver(
        SESSION,
        request.id,
        send(request.observedDigest ?? '', {
          fields: [
            { field: 'old', padded: padInputValue(PASSWORD) },
            { field: 'password', padded: padInputValue(PASSWORD) },
          ],
          save: { entry: 'GOOGLE_COM', label: 'Google' },
        }),
        HOST,
      ),
    );

    should(error.message).containEql('cannot be kept as one saved login');
    should(request.saved?.saves).be.undefined();
    should(writes).eql([]);
  });
});

describe('when the page changes under the card (#B100)', () => {
  /** The password input re-rendered as a new node (React replaced it; the agent's ref is stale now). */
  const RERENDERED: PageFacts = {
    ...PAGE,
    fields: [pageField('email'), pageField('password', { backendNodeId: 99, box: { x: 10, y: 64, w: 300, h: 40 } })],
  };

  it('should redraw the card for a field re-rendered as a new node, then type into the new node', async () => {
    const { service, request, writes, setFacts, shots, typedInto, told } = await raisedLogin();
    setFacts(RERENDERED);

    const error = await refused(service.deliver(SESSION, request.id, both(request.observedDigest ?? ''), HOST));
    const [card] = await service.list(HOST);
    const picture = service.shot(HOST, SESSION, request.id);
    const done = await service.deliver(SESSION, request.id, both(card?.observedDigest ?? ''), HOST);

    should(error.code).equal('conflict');
    should(error.reason).equal('target_rebound');
    should(error.message).equal(
      'the page changed since the card was drawn, but it is the same field: Ferretry looked again and redrew the card; check it and send again. Nothing was typed',
    );
    should(card?.observed).eql(RERENDERED);
    should(card?.pictured).equal(true);
    should(card?.risk?.level).equal('red');
    should(shots.map(seen => (seen.kind === 'browser' ? seen.fields[1]?.backendNodeId : 0))).eql([12, 99]);
    should(picture.pngBase64).equal('c2hvdA2');
    should(done.state).equal('delivered');
    should(writes.length).equal(1);
    should(typedInto.map(seen => (seen.kind === 'browser' ? seen.fields[1]?.backendNodeId : 0))).eql([99]);
    should(told.at(-1)).containEql('was answered and typed');
  });

  it('should find a field whose ref went stale by looking for it again, and redraw the card', async () => {
    const { service, request, setFacts, setRefound, refinds } = await raisedLogin();
    setFacts(undefined);
    setRefound({ ok: true, facts: RERENDERED, names: ['page-1'] });

    const error = await refused(service.deliver(SESSION, request.id, both(request.observedDigest ?? ''), HOST));

    should(error.reason).equal('target_rebound');
    should(refinds).eql([PAGE]);
    should((await service.list(HOST))[0]?.observed).eql(RERENDERED);
  });

  it('should type, without redrawing, when the field found again is exactly the one the card showed', async () => {
    const { service, request, writes, setFacts, setRefound } = await raisedLogin();
    setFacts(undefined);
    setRefound({ ok: true, facts: PAGE, names: ['page-1'] });

    const done = await service.deliver(SESSION, request.id, both(request.observedDigest ?? ''), HOST);

    should(done.state).equal('delivered');
    should(writes.length).equal(1);
  });

  const different: readonly [string, ObserveResult][] = [
    ['a page on another origin', { ok: true, facts: { ...RERENDERED, origin: 'https://evil.example' } }],
    [
      'the field in a frame from another site',
      {
        ok: true,
        facts: {
          ...RERENDERED,
          fields: [
            pageField('email'),
            pageField('password', { backendNodeId: 99, frameOrigin: 'https://evil.example' }),
          ],
        },
      },
    ],
    [
      'a password field that became a text field',
      {
        ok: true,
        facts: {
          ...PAGE,
          fields: [
            pageField('email'),
            pageField('password', { backendNodeId: 99, field: { tag: 'input', type: 'text' } }),
          ],
        },
      },
    ],
    [
      'the field hidden',
      {
        ok: true,
        facts: { ...PAGE, fields: [pageField('email'), pageField('password', { backendNodeId: 99, visible: false })] },
      },
    ],
    ['an http page', { ok: true, facts: { ...RERENDERED, secure: false } }],
    ['another page', { ok: true, facts: { ...RERENDERED, pageId: 'page-2' } }],
    ['no such field, or several look-alikes', { ok: false, reason: 'target_gone' }],
  ];
  for (const [name, found] of different) {
    it(`should refuse and count it when looking again finds ${name}`, async () => {
      const { service, request, writes, setFacts, setRefound } = await raisedLogin();
      setFacts(undefined);
      setRefound(found);

      const error = await refused(service.deliver(SESSION, request.id, both(request.observedDigest ?? ''), HOST));
      const [card] = await service.list(HOST);

      should(error.reason).equal('target_changed');
      should(card?.observedDigest).equal(request.observedDigest);
      should(card?.observed).eql(PAGE);
      should(writes).eql([]);
    });
  }

  it('should look again on a navigation to another origin and end the card after three, never typing', async () => {
    const { service, request, writes, setFacts, closed } = await raisedLogin();
    setFacts({ ...RERENDERED, origin: 'https://evil.example', navigationId: 'loader-9' });
    const reasons: (string | undefined)[] = [];
    for (let n = 0; n < 3; n += 1)
      reasons.push(
        (await refused(service.deliver(SESSION, request.id, both(request.observedDigest ?? ''), HOST))).reason,
      );

    should(reasons).eql(['target_changed', 'target_changed', 'target_unsettled']);
    should(await service.list(HOST)).eql([]);
    should(closed.length).equal(1);
    should(writes).eql([]);
  });
});
