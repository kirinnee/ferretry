import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputEvent,
  type InputRaise,
  type InputTargetFacts,
  type PasteRule,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import {
  EphemeralValues,
  type InputAuditEntry,
  type InputCaller,
  InputRequestError,
  InputRequestService,
  PasteRuleService,
  QuarantineRegistry,
  SecureCopyService,
  type TypeResult,
} from '../../../src/lib/index.ts';
import { FACTS, SESSION } from './support.ts';

const TOKEN = 'vcp_PASTE-NEVER-LEAKS-41f2';
const OWNER: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };

const VERCEL: InputTargetFacts = {
  ...FACTS,
  foreground: { pid: 5100, pgid: 5100, comm: 'vercel', argv: 'vercel env add TOKEN production' },
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
  } = {},
) {
  const ms = { now: Date.parse('2026-10-31T12:00:00.000Z') };
  const clock = { now: () => ms.now };
  const values = new EphemeralValues(clock);
  const writes: string[] = [];
  const events: InputEvent[] = [];
  const audits: InputAuditEntry[] = [];
  const told: string[] = [];
  const cards: { title: string; ask: string }[] = [];
  const closed: string[] = [];
  const typed: { result: TypeResult } = { result: 'typed' };
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
      }),
    },
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => options.transcript ?? 'clean' },
    masking: values,
    redact: async text => text,
  });
  const stored: { rules: readonly PasteRule[] | undefined } = { rules: undefined };
  let ruleIds = 0;
  const rules = new PasteRuleService({
    store: {
      read: async () => stored.rules,
      write: async next => {
        stored.rules = next;
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
    target: {
      observe: async () => ({ ok: true, facts: facts.current }),
      type: async (_session, _target, text) => {
        writes.push(text);
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
      quarantine: async () => undefined,
      quarantines: async () => [],
    },
    audit: { record: async entry => void audits.push(entry), saved: async () => undefined },
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
        ask: `Allow pasting sealed:vercel (${String(TOKEN.length)} characters from vercel) into the terminal. You type nothing.`,
      },
    ]);
    should(request?.sensitivity).equal('secret');
    should(request?.source).eql({ kind: 'sealed', name: 'vercel', from: { kind: 'command', program: 'vercel' } });
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

  it('should wait for the owner when the destination program is not the one the rule names', async () => {
    const w = await world({ facts: { ...VERCEL, foreground: { ...VERCEL.foreground, comm: 'zsh' } } });
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
    should(w.rules.reserve(SESSION, { kind: 'command', program: 'vercel' }, VERCEL)).equal(rule.id);
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
