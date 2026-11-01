import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputEvent,
  type InputRaise,
  type InputTargetFacts,
  type PasteRule,
  type PasteRuleSettings,
  padInputValue,
  type SecretName,
} from '@ferretry/protocol';
import should from 'should';
import type { BrowserInputFacts, BrowserInputFieldsPort } from '../../../src/lib/browser/transport/input-contracts.ts';
import {
  EphemeralValues,
  type InputAuditEntry,
  type InputCaller,
  InputRequestError,
  InputRequestService,
  type InputStoreAuditEntry,
  type InputTargetPort,
  PasteRuleService,
  QuarantineRegistry,
  SecureCopyService,
  type TypeResult,
} from '../../../src/lib/index.ts';
import { PageInputTarget } from '../../../src/lib/input-requests/page-target.ts';
import { FACTS, SESSION } from './support.ts';

const TOKEN = 'vcp_PASTE-NEVER-LEAKS-41f2';
const OWNER: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };

const VERCEL: InputTargetFacts = {
  ...FACTS,
  foreground: { pid: 5100, pgid: 5100, comm: 'vercel', argv: 'vercel env add TOKEN production' },
  program: 'vercel',
  promptLine: '? What’s the value of TOKEN?',
  recognisedConsumer: false,
};

const PASTE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'the new Vercel token for production',
  sensitivity: 'plain',
  submit: 'owner-default',
  source: { kind: 'sealed', name: 'vercel' },
};

/** The input bridge with the real secure copy and rule services, over fakes that record every byte they see. */
async function world(
  options: {
    readonly facts?: InputTargetFacts;
    readonly stdout?: string;
    readonly transcript?: 'found' | 'clean';
    /** What an earlier run left in the journal, for a restart. */
    readonly history?: readonly InputEvent[];
    /** A real target in place of the recording fake (a page target over a fake browser). */
    readonly target?: InputTargetPort;
  } = {},
) {
  const ms = { now: Date.parse('2026-10-31T12:00:00.000Z') };
  const clock = { now: () => ms.now };
  const values = new EphemeralValues(clock);
  const writes: string[] = [];
  const events: InputEvent[] = [];
  const audits: InputAuditEntry[] = [];
  const stores: InputStoreAuditEntry[] = [];
  const told: string[] = [];
  const cards: { title: string; ask: string }[] = [];
  const closed: string[] = [];
  const typed: { result: TypeResult } = { result: 'typed' };
  const held = { quarantines: 0 };
  const facts = { current: options.facts ?? VERCEL };
  const copies = new SecureCopyService({
    clock,
    runner: {
      run: async () => ({
        outcome: 'exited',
        exitCode: 0,
        stdout: options.stdout ?? `${TOKEN}\n`,
        stderr: '',
        truncated: false,
        // The vercel the daemon found on its PATH, in a folder no ferret can write.
        program: '/usr/bin/vercel',
      }),
    },
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => options.transcript ?? 'clean' },
    masking: values,
    redact: async text => text,
  });
  const stored: { rules: readonly PasteRule[] | undefined; settings: PasteRuleSettings } = {
    rules: undefined,
    settings: { allowProfileTargets: false },
  };
  let ruleIds = 0;
  const rules = new PasteRuleService({
    store: {
      read: async () => (stored.rules === undefined ? undefined : { rules: stored.rules, settings: stored.settings }),
      write: async next => {
        stored.rules = next.rules;
        stored.settings = next.settings;
      },
    },
    clock,
    ids: { ruleId: () => (++ruleIds).toString(16).padStart(32, 'f') },
    warn: () => undefined,
  });
  await rules.load();
  let card = 1;
  let id = 1;
  const service = new InputRequestService({
    target: options.target ?? {
      observe: async () => ({ ok: true, facts: facts.current }),
      type: async (_session, _target, values) => {
        writes.push(...values.map(value => value.text));
        return typed.result;
      },
    },
    agenda: {
      raise: async (_session, raised) => {
        cards.push({ title: raised.title, ask: raised.ask });
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, closedId, note) => void closed.push(`${closedId}: ${note}`),
      promptOf: async () => 'the new Vercel token for production',
    },
    notifier: { tell: async (_session, _agenda, message) => void told.push(message) },
    journal: {
      publish: async (_session, event) => void events.push(event),
      history: async () => options.history ?? [],
      quarantine: async () => {
        held.quarantines += 1;
      },
      quarantines: async () => [],
    },
    audit: {
      record: async entry => void audits.push(entry),
      saved: async () => undefined,
      stored: async entry => void stores.push(entry),
    },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== SESSION, all: async () => [SESSION] },
    values,
    quarantine: new QuarantineRegistry(clock),
    redact: async text => values.scrubAll(text),
    sealed: copies,
    rules,
  });
  const capture = async () =>
    await copies.capture(SESSION, {
      name: 'vercel',
      source: { kind: 'command', argv: ['vercel', 'tokens', 'create'] },
    });
  const allow = (digest: string, extra: Partial<InputDeliverBody> = {}): InputDeliverBody =>
    ({
      deliveryId: crypto.randomUUID(),
      observedDigest: digest,
      sealed: true,
      submit: true,
      ...extra,
    }) as InputDeliverBody;
  const pending = async () => (await service.list(OWNER, SESSION))[0];
  return {
    ms,
    service,
    copies,
    rules,
    stored,
    writes,
    events,
    audits,
    stores,
    held,
    told,
    cards,
    closed,
    typed,
    facts,
    values,
    capture,
    allow,
    pending,
  };
}

const refusal = async (work: Promise<unknown>): Promise<InputRequestError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(InputRequestError);
  return error as InputRequestError;
};

describe('pasting a secure copy as an input request', () => {
  it('should refuse a paste of a copy that is not live, and raise no card', async () => {
    const w = await world();

    const error = await refusal(w.service.raise(SESSION, PASTE));

    should(error.code).equal('not_found');
    should(error.message).containEql('sealed:vercel');
    should(w.cards).eql([]);
  });

  it('should raise a paste card, always as a secret, naming where the copy came from and nothing to type', async () => {
    const w = await world();
    await w.capture();

    const view = await w.service.raise(SESSION, PASTE);
    const request = await w.pending();

    should(view.state).equal('pending');
    should(w.cards).eql([
      {
        title: 'Wants to paste a secure copy',
        ask: `Allow pasting sealed:vercel (${String(TOKEN.length)} characters from /usr/bin/vercel) into the terminal. You type nothing.`,
      },
    ]);
    should(request?.sensitivity).equal('secret');
    should(request?.source).eql({
      kind: 'sealed',
      name: 'vercel',
      from: { kind: 'command', program: 'vercel', path: '/usr/bin/vercel' },
    });
    should(w.events.map(event => event.sealed)).eql(['vercel']);
  });

  it('should flag a copy the ferret had already seen, whatever else the terminal says', async () => {
    const w = await world({ transcript: 'found', facts: { ...VERCEL, recognisedConsumer: true } });
    await w.capture();

    await w.service.raise(SESSION, PASTE);

    should((await w.pending())?.risk).eql({
      level: 'amber',
      reason: 'The ferret saw this value before it was sealed, so it is not protected; consider rotating it.',
    });
  });

  it('should type the copy once when the owner allows it, and tell the agent it was pasted', async () => {
    const w = await world();
    await w.capture();
    const view = await w.service.raise(SESSION, PASTE);
    const request = await w.pending();

    const result = await w.service.deliver(SESSION, request?.id ?? '', w.allow(request?.observedDigest ?? ''), OWNER);
    const after = await w.service.agentView(SESSION, view.id, 0);

    should(result).match({ state: 'delivered', submitted: true });
    should(w.held.quarantines).be.above(0);
    should(w.writes).eql([TOKEN]);
    should(after).match({ state: 'delivered', source: 'sealed' });
    should(w.copies.list(SESSION)[0]?.uses).equal(1);
    should(w.told.at(-1)).containEql('sealed:vercel was pasted into %terminal:dev');
  });

  it('should refuse a typed value or a saved login on a paste card, and a paste body on an ordinary card, typing nothing', async () => {
    const w = await world();
    await w.capture();
    await w.service.raise(SESSION, PASTE);
    const paste = await w.pending();
    const typed = {
      deliveryId: crypto.randomUUID(),
      observedDigest: paste?.observedDigest ?? '',
      padded: padInputValue('guess'),
      submit: true,
    };

    const typedError = await refusal(w.service.deliver(SESSION, paste?.id ?? '', typed, OWNER));
    should(typedError.message).equal('this card pastes sealed:vercel: allow it, there is nothing to type');

    await w.service.cancel(SESSION, paste?.id ?? '', OWNER);
    await w.service.raise(SESSION, { ...PASTE, source: undefined, sensitivity: 'secret' } as InputRaise);
    const ordinary = await w.pending();
    const sealedError = await refusal(
      w.service.deliver(SESSION, ordinary?.id ?? '', w.allow(ordinary?.observedDigest ?? ''), OWNER),
    );
    should(sealedError.message).equal('this card pastes no secure copy; type the value instead');
    should(w.writes).eql([]);
  });

  it('should refuse an agent allowing its own paste', async () => {
    const w = await world();
    await w.capture();
    await w.service.raise(SESSION, PASTE);
    const request = await w.pending();

    const error = await refusal(
      w.service.deliver(SESSION, request?.id ?? '', w.allow(request?.observedDigest ?? ''), AGENT),
    );

    should(error.code).equal('forbidden');
    should(w.writes).eql([]);
  });

  it('should end the request, typing nothing, when the copy was discarded before the owner allowed it', async () => {
    const w = await world();
    await w.capture();
    await w.service.raise(SESSION, PASTE);
    const request = await w.pending();
    w.copies.discard(SESSION, 'vercel');

    const error = await refusal(
      w.service.deliver(SESSION, request?.id ?? '', w.allow(request?.observedDigest ?? ''), OWNER),
    );

    should(error.code).equal('gone');
    should(w.writes).eql([]);
    should(w.events.at(-1)).match({ state: 'cancelled', reason: 'copy_gone' });
    should(w.closed.at(-1)).containEql('copy gone');
  });

  it('should refuse to paste a copy with a line break into a terminal, typing nothing', async () => {
    const w = await world({ stdout: 'line one\nline two' });
    await w.capture();
    await w.service.raise(SESSION, PASTE);
    const request = await w.pending();

    const error = await refusal(
      w.service.deliver(SESSION, request?.id ?? '', w.allow(request?.observedDigest ?? ''), OWNER),
    );

    should(error.message).containEql('would press keys');
    should(w.writes).eql([]);
  });

  it('should never put the copy in a journal event, an audit entry, a card, a listing or what the agent is told', async () => {
    const w = await world();
    await w.capture();
    const view = await w.service.raise(SESSION, PASTE);
    const request = await w.pending();
    await w.service.deliver(SESSION, request?.id ?? '', w.allow(request?.observedDigest ?? ''), OWNER);

    const seen = JSON.stringify({
      events: w.events,
      audits: w.audits,
      cards: w.cards,
      told: w.told,
      closed: w.closed,
      list: await w.service.list(OWNER, SESSION),
      view: await w.service.agentView(SESSION, view.id, 0),
      copies: w.copies.list(SESSION),
    });

    should(seen).not.containEql(TOKEN);
    should(w.audits.at(-1)?.detail).match({ source: 'sealed', copy: 'vercel' });
  });
});

describe('a paste the owner approved in advance', () => {
  const RULE = { from: { kind: 'command', program: 'vercel' }, to: { kind: 'terminal', program: 'vercel' } } as const;

  it('should be pasted at once under the rule, still raised, audited as the rule and closed for the log', async () => {
    const w = await world();
    const rule = await w.rules.create({ kind: 'owner', actor: { kind: 'host' } }, { ...RULE, count: 2 });
    await w.capture();

    const view = await w.service.raise(SESSION, PASTE);

    should(view).match({
      state: 'delivered',
      source: 'sealed',
      note: 'Pasted under a rule the owner approved in advance.',
    });
    should(w.writes).eql([TOKEN]);
    should(w.cards).have.length(1);
    should(w.closed).have.length(1);
    should(w.audits.at(-1)).match({ event: 'input.delivered', actor: { kind: 'rule', ruleId: rule.id } });
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    should(w.rules.list({ kind: 'owner', actor: { kind: 'host' } })).match([{ id: rule.id, remaining: 1, used: 1 }]);
  });

  describe('into a program proved only through the owner profile', () => {
    const OWNER = { kind: 'owner', actor: { kind: 'host' } } as const;
    const STORE_PATH = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-vercel/bin/vercel';
    const IN_PROFILE = {
      ...VERCEL,
      program: undefined,
      profileProgram: { name: 'vercel', path: STORE_PATH },
    } as InputTargetFacts;

    it('should ask the owner while profile targets are off (the default)', async () => {
      const w = await world({ facts: IN_PROFILE });
      await w.rules.create(OWNER, RULE);
      await w.capture();

      const view = await w.service.raise(SESSION, PASTE);

      should(view.state).equal('pending');
      should(w.writes).eql([]);
    });

    it('should paste under the rule once the owner allowed them, and log the store file it pasted into', async () => {
      const w = await world({ facts: IN_PROFILE });
      const rule = await w.rules.create(OWNER, RULE);
      await w.rules.changeSettings(OWNER, { allowProfileTargets: true });
      await w.capture();

      const view = await w.service.raise(SESSION, PASTE);

      should(view.state).equal('delivered');
      should(w.writes).eql([TOKEN]);
      should(w.audits.at(-1)).match({
        event: 'input.delivered',
        actor: { kind: 'rule', ruleId: rule.id },
        detail: { profileProgram: STORE_PATH },
      });
      should(JSON.stringify(w.audits)).not.containEql(TOKEN);
    });

    it('should never paste into a program proved by neither a system folder nor the profile (~/bin)', async () => {
      const w = await world({ facts: { ...VERCEL, program: undefined } as InputTargetFacts });
      await w.rules.create(OWNER, RULE);
      await w.rules.changeSettings(OWNER, { allowProfileTargets: true });
      await w.capture();

      const view = await w.service.raise(SESSION, PASTE);

      should(view.state).equal('pending');
      should(w.writes).eql([]);
    });
  });

  it('should wait for the owner when the destination program is not the one the rule names', async () => {
    const w = await world({ facts: { ...VERCEL, foreground: { ...VERCEL.foreground, comm: 'zsh' }, program: 'zsh' } });
    await w.rules.create({ kind: 'owner', actor: { kind: 'host' } }, RULE);
    await w.capture();

    const view = await w.service.raise(SESSION, PASTE);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
  });

  it("should spend a rule's last use once, so a second paste asks the owner", async () => {
    const w = await world();
    await w.rules.create({ kind: 'owner', actor: { kind: 'host' } }, { ...RULE, count: 1 });
    await w.capture();
    await w.copies.capture(SESSION, { name: 'second', source: { kind: 'command', argv: ['vercel'] } });

    const first = await w.service.raise(SESSION, PASTE);
    const second = await w.service.raise(SESSION, {
      ...PASTE,
      target: { kind: 'terminal', key: 'other' },
      source: { kind: 'sealed', name: 'second' },
    });

    should([first.state, second.state]).eql(['delivered', 'pending']);
    should(w.writes).eql([TOKEN]);
  });

  it('should give the use back and leave the card for the owner when the guarded write refuses', async () => {
    const w = await world();
    const rule = await w.rules.create({ kind: 'owner', actor: { kind: 'host' } }, { ...RULE, count: 1 });
    await w.capture();
    w.typed.result = 'target_changed';

    const view = await w.service.raise(SESSION, PASTE);

    should(view.state).equal('pending');
    should(w.rules.reserve(SESSION, { kind: 'command', program: 'vercel', path: '/usr/bin/vercel' }, VERCEL)).equal(
      rule.id,
    );
  });
});

describe('a paste after a daemon restart', () => {
  it('should end as copy_gone, because a restart forgets every copy, and close its card', async () => {
    const w = await world();
    await w.capture();
    await w.service.raise(SESSION, PASTE);
    const restarted = await world({ history: [...w.events] });

    await restarted.service.restore();

    should(restarted.events.at(-1)).match({ state: 'cancelled', reason: 'copy_gone' });
    should(restarted.closed).have.length(1);
    should(restarted.writes).eql([]);
  });
});

describe('what the security review found about pastes approved in advance', () => {
  const RULE = { from: { kind: 'command', program: 'vercel' }, to: { kind: 'terminal', program: 'vercel' } } as const;
  const OWNS = { kind: 'owner', actor: { kind: 'host' } } as const;

  it("should spend the rule's use when the write may have typed, never give it back", async () => {
    const w = await world();
    await w.rules.create(OWNS, { ...RULE, count: 1 });
    await w.capture();
    w.typed.result = 'uncertain';

    await w.service.raise(SESSION, PASTE);
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();

    should(w.rules.reserve(SESSION, { kind: 'command', program: 'vercel' }, VERCEL)).be.undefined();
  });

  it('should leave the card for the owner when the terminal shows what is typed, whatever the rule says', async () => {
    const w = await world({ facts: { ...VERCEL, echo: 'on' } });
    await w.rules.create(OWNS, RULE);
    await w.capture();

    const view = await w.service.raise(SESSION, PASTE);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
  });
});

describe('a paste raised with named fields', () => {
  it('should refuse a paste of more than one field, and make the one field it names a secret', async () => {
    const w = await world();
    await w.capture();
    const { sensitivity: _sensitivity, ...base } = PASTE;

    const several = await refusal(
      w.service.raise(SESSION, {
        ...base,
        target: { kind: 'browser', key: 'app' },
        fields: [
          { id: 'user', sensitivity: 'plain', element: { kind: 'ref', ref: 'e1' } },
          { id: 'token', sensitivity: 'plain', element: { kind: 'ref', ref: 'e2' } },
        ],
      }),
    );
    await w.service.raise(SESSION, { ...base, fields: [{ id: 'token', sensitivity: 'plain' }] });

    should(several.message).equal('a paste fills one field: raise it with one field');
    should((await w.pending())?.fields.map(field => field.sensitivity)).eql(['secret']);
  });
});

describe('a pre-approved paste into a page', () => {
  const page = (type: string): InputTargetFacts => ({
    kind: 'browser',
    pageId: 'page-1',
    origin: 'https://vercel.com',
    secure: true,
    navigationId: 'nav-1',
    fields: [
      {
        fieldId: 'token',
        frameOrigin: 'https://vercel.com',
        frameId: 'frame-1',
        backendNodeId: 7,
        field: { tag: 'input', type },
        box: { x: 0, y: 0, w: 200, h: 32 },
        visible: true,
      },
    ],
  });
  const INTO_PAGE: InputRaise = {
    target: { kind: 'browser', key: 'app' },
    prompt: 'the Vercel token for the env page',
    fields: [{ id: 'token', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
    submit: 'offer-owner',
    source: { kind: 'sealed', name: 'vercel' },
  };
  const RULE = {
    from: { kind: 'command', program: 'vercel' },
    to: { kind: 'browser', origin: 'https://vercel.com' },
  } as const;

  it('should paste at once into a password field the rule names, and wait for the owner on a text field', async () => {
    const hidden = await world({ facts: page('password') });
    await hidden.rules.create({ kind: 'owner', actor: { kind: 'host' } }, RULE);
    await hidden.capture();
    const shown = await world({ facts: page('text') });
    await shown.rules.create({ kind: 'owner', actor: { kind: 'host' } }, RULE);
    await shown.capture();

    const pasted = await hidden.service.raise(SESSION, INTO_PAGE);
    const waiting = await shown.service.raise(SESSION, INTO_PAGE);

    should([pasted.state, waiting.state]).eql(['delivered', 'pending']);
    should([hidden.writes, shown.writes]).eql([[TOKEN], []]);
  });
});

describe('a paste saved as a secret', () => {
  const NEW_SECRET: InputTargetFacts = { kind: 'secret', name: 'VERCEL_TOKEN' as SecretName, exists: false };
  const INTO_STORE: InputRaise = {
    target: { kind: 'secret', key: 'VERCEL_TOKEN' as SecretName },
    prompt: 'the minted Vercel token',
    sensitivity: 'plain',
    submit: 'agent',
    source: { kind: 'sealed', name: 'vercel' },
  };
  const OWNER_RULER = { kind: 'owner', actor: { kind: 'host' } } as const;

  it('should refuse a store target that is not a paste, raising no card', async () => {
    const w = await world({ facts: NEW_SECRET });

    const error = await refusal(w.service.raise(SESSION, { ...INTO_STORE, source: undefined } as InputRaise));
    const fields = await refusal(
      w.service.raise(SESSION, {
        ...INTO_STORE,
        sensitivity: undefined,
        fields: [{ id: 'value', sensitivity: 'secret', element: { kind: 'ref', ref: 'e1' } }],
      } as unknown as InputRaise),
    );

    should(error.message).equal(
      'the secret store takes only a secure copy, by secure.paste; the owner adds other secrets in Settings',
    );
    should(fields.message).equal('a secret holds one value: raise it with one field and no element');
    should(w.cards).eql([]);
  });

  it('should ask the owner naming the secret, green when new and amber when it replaces one', async () => {
    const fresh = await world({ facts: NEW_SECRET });
    await fresh.capture();
    const replacing = await world({ facts: { ...NEW_SECRET, exists: true } });
    await replacing.capture();

    await fresh.service.raise(SESSION, INTO_STORE);
    await replacing.service.raise(SESSION, INTO_STORE);

    should(fresh.cards[0]?.ask).equal(
      `Allow pasting sealed:vercel (${String(TOKEN.length)} characters from /usr/bin/vercel) into the secret VERCEL_TOKEN. You type nothing.`,
    );
    should(replacing.cards[0]?.ask).containEql('into the secret VERCEL_TOKEN, replacing its value.');
    should((await fresh.pending())?.risk?.level).equal('green');
    should((await replacing.pending())?.risk).eql({
      level: 'amber',
      reason: 'This replaces the value the secret holds now; the old value is gone for good.',
    });
  });

  it('should save it once the owner allows it, keep the change in the secrets log and tell the agent its name', async () => {
    const w = await world({ facts: NEW_SECRET });
    await w.capture();
    const view = await w.service.raise(SESSION, INTO_STORE);
    const request = await w.pending();

    await w.service.deliver(SESSION, request?.id ?? '', w.allow(request?.observedDigest ?? ''), OWNER);

    should(w.writes).eql([TOKEN]);
    should(w.held.quarantines).equal(0);
    should(w.stores).eql([
      { sessionId: SESSION, requestId: request?.id, actor: OWNER.actor, name: 'VERCEL_TOKEN', replaced: false },
    ]);
    should(w.told.at(-1)).equal(
      `${view.id}: sealed:vercel was saved as the secret VERCEL_TOKEN. Use it as \${secret:VERCEL_TOKEN}; you can never read it.`,
    );
    should(JSON.stringify([w.stores, w.audits, w.events, w.told])).not.containEql(TOKEN);
  });

  it('should tell the agent the secret was not saved when the owner declines, or may be when the write was cut', async () => {
    const declined = await world({ facts: NEW_SECRET });
    await declined.capture();
    await declined.service.raise(SESSION, INTO_STORE);
    const cut = await world({ facts: NEW_SECRET });
    await cut.capture();
    await cut.service.raise(SESSION, INTO_STORE);
    const request = await cut.pending();
    cut.typed.result = 'uncertain';

    await declined.service.cancel(SESSION, (await declined.pending())?.id ?? '', OWNER);
    await cut.service
      .deliver(SESSION, request?.id ?? '', cut.allow(request?.observedDigest ?? ''), OWNER)
      .catch(() => undefined);

    should(declined.told.at(-1)).match(/ended without saving sealed:vercel \(cancelled.*call secure_paste again/);
    should(cut.told.at(-1)).containEql('it may or may not hold it now');
    should(cut.stores).match([{ name: 'VERCEL_TOKEN', uncertain: true }]);
    should(declined.stores).eql([]);
  });

  it('should save at once under a rule naming that exact secret, and wait for the owner under any other name', async () => {
    const named = await world({ facts: NEW_SECRET });
    const rule = await named.rules.create(OWNER_RULER, {
      from: { kind: 'command', program: 'vercel' },
      to: { kind: 'secret', name: 'VERCEL_TOKEN' as SecretName },
    });
    await named.capture();
    const other = await world({ facts: NEW_SECRET });
    await other.rules.create(OWNER_RULER, {
      from: { kind: 'command', program: 'vercel' },
      to: { kind: 'secret', name: 'VERCEL_TOKEN_2' as SecretName },
    });
    await other.capture();

    const saved = await named.service.raise(SESSION, INTO_STORE);
    const waiting = await other.service.raise(SESSION, INTO_STORE);

    should([saved.state, waiting.state]).eql(['delivered', 'pending']);
    should([named.writes, other.writes]).eql([[TOKEN], []]);
    should(named.stores).match([{ actor: { kind: 'rule', ruleId: rule.id }, name: 'VERCEL_TOKEN' }]);
  });
});

describe('what a rule never pastes unasked (the security review of SC2b)', () => {
  const OWNER_RULER = { kind: 'owner', actor: { kind: 'host' } } as const;
  const SECRET: InputTargetFacts = { kind: 'secret', name: 'VERCEL_TOKEN' as SecretName, exists: true };
  const INTO_STORE: InputRaise = {
    target: { kind: 'secret', key: 'VERCEL_TOKEN' as SecretName },
    prompt: 'the minted Vercel token',
    sensitivity: 'secret',
    submit: 'agent',
    source: { kind: 'sealed', name: 'vercel' },
  };

  it('should wait for the owner before replacing a secret, even under a rule naming it', async () => {
    const w = await world({ facts: SECRET });
    await w.rules.create(OWNER_RULER, {
      from: { kind: 'command', program: 'vercel' },
      to: { kind: 'secret', name: 'VERCEL_TOKEN' as SecretName },
    });
    await w.capture();

    const view = await w.service.raise(SESSION, INTO_STORE);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(w.rules.list(OWNER_RULER)).match([{ used: 0 }]);
  });

  it('should wait for the owner on a copy the ferret had already seen, whatever the rule says', async () => {
    const w = await world({ transcript: 'found', facts: { ...VERCEL, echo: 'off' } });
    await w.rules.create(OWNER_RULER, {
      from: { kind: 'command', program: 'vercel' },
      to: { kind: 'terminal', program: 'vercel' },
    });
    await w.capture();

    const view = await w.service.raise(SESSION, PASTE);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
  });
});

describe('a paste into a field on a page', () => {
  const PAGE: BrowserInputFacts = {
    kind: 'browser',
    pageId: 'page-1',
    origin: 'https://vercel.com',
    secure: true,
    navigationId: 'loader-1',
    fields: [
      {
        fieldId: 'value',
        frameOrigin: 'https://vercel.com',
        frameId: 'main',
        backendNodeId: 7,
        field: { tag: 'input', type: 'password' },
        box: { x: 0, y: 0, w: 200, h: 32 },
        visible: true,
      },
    ],
  };
  const INTO_FIELD: InputRaise = {
    target: { kind: 'browser', key: 'app' },
    prompt: 'the Vercel token for the env page',
    fields: [{ id: 'value', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
    submit: 'offer-owner',
    source: { kind: 'sealed', name: 'vercel' },
  };

  /** The real page target over a fake browser that records what it was asked to type. */
  function browser(facts: BrowserInputFacts = PAGE) {
    const typed: { field: string; text: string }[] = [];
    const port: BrowserInputFieldsPort = {
      inputDocument: async () => ({ navigationId: 'loader-1' }),
      inputObserve: async () => ({ ok: true, facts }),
      inputRefind: async () => ({ ok: true, facts }),
      inputShot: async () => ({ pngBase64: 'AAAA', clip: { x: 0, y: 0, w: 10, h: 10 } }),
      inputType: async (_pageId, _expected, values) => {
        typed.push(...values);
        return 'typed';
      },
    };
    return {
      typed,
      target: new PageInputTarget({ inputOnPage: async (_sessionId, _key, work) => await work(port, 'page-1') }),
    };
  }

  it("should ask the owner naming the page's host, then type the copy into that one field and hold the page", async () => {
    const page = browser();
    const w = await world({ target: page.target });
    await w.capture();

    const view = await w.service.raise(SESSION, INTO_FIELD);
    const request = await w.pending();
    await w.service.deliver(SESSION, request?.id ?? '', w.allow(request?.observedDigest ?? ''), OWNER);

    should(w.cards[0]?.ask).equal(
      `Allow pasting sealed:vercel (${String(TOKEN.length)} characters from /usr/bin/vercel) into a field on vercel.com. You type nothing.`,
    );
    should(page.typed).eql([{ field: 'value', text: TOKEN }]);
    should(w.service.pageHeld(SESSION, ['app'])).match({ documents: ['loader-1'] });
    should(w.told.at(-1)).containEql(`${view.id}: sealed:vercel was pasted into %browser:app`);
    should(JSON.stringify([w.audits, w.events, w.told, w.cards])).not.containEql(TOKEN);
  });

  it('should paste at once under a rule for the page origin into a password field', async () => {
    const page = browser();
    const w = await world({ target: page.target });
    await w.rules.create(
      { kind: 'owner', actor: { kind: 'host' } },
      { from: { kind: 'command', program: 'vercel' }, to: { kind: 'browser', origin: 'https://vercel.com' } },
    );
    await w.capture();

    const view = await w.service.raise(SESSION, INTO_FIELD);

    should(view.state).equal('delivered');
    should(page.typed).eql([{ field: 'value', text: TOKEN }]);
  });

  it('should wait for the owner under a rule for the page origin whenever the card would flag the field', async () => {
    const [only] = PAGE.fields;
    if (only === undefined) throw new Error('no field');
    const flagged: readonly BrowserInputFacts[] = [
      // A password field inside a frame from another site, on the very page the rule names.
      { ...PAGE, fields: [{ ...only, frameOrigin: 'https://evil.example' }] },
      { ...PAGE, fields: [{ ...only, visible: false }] },
      { ...PAGE, fields: [{ ...only, covered: true }] },
      { ...PAGE, challenge: { provider: 'recaptcha' } } as BrowserInputFacts,
    ];

    const outcomes = [];
    for (const facts of flagged) {
      const page = browser(facts);
      const w = await world({ target: page.target });
      await w.rules.create(
        { kind: 'owner', actor: { kind: 'host' } },
        { from: { kind: 'command', program: 'vercel' }, to: { kind: 'browser', origin: 'https://vercel.com' } },
      );
      await w.capture();
      outcomes.push({ state: (await w.service.raise(SESSION, INTO_FIELD)).state, typed: page.typed.length });
    }

    should(outcomes).eql(flagged.map(() => ({ state: 'pending', typed: 0 })));
  });
});
