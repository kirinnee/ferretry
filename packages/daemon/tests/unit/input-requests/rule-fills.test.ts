import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputRaise,
  type InputTargetFacts,
  PutLoginEntryRequestSchema,
  type SignInId,
  type SignInRuleDraft,
  type SignInRuleId,
} from '@ferretry/protocol';
import should from 'should';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { InputAuditAdapter } from '../../../src/lib/input-requests/audit-adapter.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputLoginAdapter } from '../../../src/lib/input-requests/login-adapter.ts';
import { identityOf } from '../../../src/lib/input-requests/login-observer.ts';
import type { InputCaller, InputCard, TypeResult } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { LoginDirectory, LoginVault, totpCode } from '../../../src/lib/secrets/index.ts';
import type { ClearOutcome } from '../../../src/lib/sign-in-grants/clear.ts';
import { SignInGrantLedger } from '../../../src/lib/sign-in-grants/ledger.ts';
import { PlanSignInGrants } from '../../../src/lib/sign-in-grants/plans.ts';
import { RuleSignInGrants } from '../../../src/lib/sign-in-grants/rules.ts';
import { CombinedSignInGrants } from '../../../src/lib/sign-in-grants/sources.ts';
import { type RuleListing, SignInRuleService } from '../../../src/lib/sign-in-rules/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments, plantSeed } from '../runtime/mounts/support.ts';
import { approved, DEVICE, FakeProofs, MemoryRuleStore, tappedFact, type World } from '../sign-in-rules/support.ts';

/**
 * R3c-4, STANDING RULE FILLS through the REAL input service, the REAL account store and the REAL rule service (fake
 * cipher, fake passkey registry, memory files): a card a rule covers is filled under it for any ferret, only after every
 * check holds on what the daemon saw and the rule's proof and pinned facts are checked again; anything less types
 * nothing, leaves the owner's card with the rule's reason, and tells the ferret exactly what it would be told if there
 * were no rule at all.
 */

const SESSION = 'mvv6b4qw-49d0158d';
const OTHER = 'mvv6b4qw-49d0158e';
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const PASSWORD = 'correct-horse-battery-staple';
const USERNAME = 'kirinnee';
const SEED = 'JBSWY3DPEHPK3PXP';
const SIX = { algorithm: 'SHA1', digits: 6, period: 30 } as const;
const PROJECT = '0b4cbd4a-6f1c-4d3c-9d55-2a3f5f1c9e01';
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };

type PageFacts = Extract<InputTargetFacts, { readonly kind: 'browser' }>;
type PageField = PageFacts['fields'][number];

const field = (fieldId: string, over: Partial<PageField> = {}, attrs: Partial<PageField['field']> = {}): PageField => ({
  fieldId,
  frameOrigin: 'https://github.com',
  frameId: 'main',
  backendNodeId: fieldId === 'user' ? 11 : fieldId === 'pass' ? 12 : 13,
  field: {
    tag: 'input',
    ...(fieldId === 'pass'
      ? { type: 'password', name: 'password' }
      : fieldId === 'user'
        ? { type: 'text', name: 'login' }
        : {}),
    ...attrs,
  },
  box: { x: 10, y: 10, w: 200, h: 40 },
  visible: true,
  ...over,
});

const loginPage = (over: Partial<PageFacts> = {}, fields: PageField[] = [field('user'), field('pass')]): PageFacts => ({
  kind: 'browser',
  pageId: 'page-1',
  origin: 'https://github.com',
  secure: true,
  navigationId: 'loader-1',
  fields,
  ...over,
});
const codePage = loginPage({ navigationId: 'loader-2' }, [
  field('otp', {}, { type: 'text', autocomplete: 'one-time-code' }),
]);

type TerminalFacts = Extract<InputTargetFacts, { readonly kind: 'terminal' }>;

/** sudo asking for the password, every member of its group PROVED by the kernel to run it setuid root, echo off. */
const sudoPrompt = (over: Partial<TerminalFacts> = {}): TerminalFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
  program: 'sudo',
  canonical: true,
  recognisedConsumer: true,
  trustedProgram: true,
  ...over,
});

const SUDO_RAISE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
};

const SIGN_IN: InputRaise = {
  target: { kind: 'browser', key: 'app' },
  prompt: 'GitHub wants a login',
  fields: [
    { id: 'user', sensitivity: 'plain', element: { kind: 'ref', ref: 'e1' } },
    { id: 'pass', sensitivity: 'secret', element: { kind: 'ref', ref: 'e2' } },
  ],
  submit: 'owner-default',
};
const CODE_RAISE: InputRaise = {
  target: { kind: 'browser', key: 'app' },
  prompt: 'GitHub wants the 2FA code',
  fields: [{ id: 'otp', sensitivity: 'code', element: { kind: 'ref', ref: 'e3' } }],
  submit: 'owner-default',
};

interface Options {
  /** Whether the daemon advertises `sign-in-rules.1`. */
  advertised?: boolean;
  written?: TypeResult;
  clear?: ClearOutcome;
  /** The session's stamped project. */
  project?: string;
  /** Runs as each journal event is published: `delivering` is the last step before the write. */
  onJournal?: (type: string, h: Harness) => void | Promise<void>;
  /** Runs inside the target's turn, before it asks whether the fill may still go ahead. */
  onQueued?: (h: Harness) => void;
  /** The owner's history also holds the code form (it never can today: a code box is no password box). */
  codeHistory?: boolean;
  /** The ferret acts on its pages while the card is being raised (after the raise's own look). */
  actDuringRaise?: boolean;
  /** The daemon's dummy probe finds the password field hiding what is typed, so the raise's lock is the short one. */
  probes?: boolean;
}

async function harness(options: Options = {}) {
  const writes: string[] = [];
  const armed: boolean[] = [];
  const cards: InputCard[] = [];
  const quietAtRaise: boolean[] = [];
  const notes: string[] = [];
  const closes: string[] = [];
  const tells: string[] = [];
  const rebuzzes: string[] = [];
  const audits: AuditEntry[] = [];
  const timers: { ms: number; fire: () => void }[] = [];
  let facts: InputTargetFacts = loginPage();
  let acted: number | undefined;
  let card = 1;
  let id = 1;
  const clock = { now: NOW };
  const values = new EphemeralValues({ now: () => clock.now });
  const index = new MemoryLoginIndex();
  const sealed = new MemorySecretDocuments();
  const cipher = new FakeSecretCipher();
  const directory = new LoginDirectory(index, sealed, cipher, { now: () => new Date(NOW).toISOString() });
  const logins = new InputLoginAdapter(directory, new LoginVault(index, sealed, cipher));
  // The owner's own taps left history at github.com for the login form (the observer is a fake here). Never the code
  // form: the history counts only forms whose secret went into a password box.
  const history = [
    identityOf(loginPage(), 'github.com'),
    ...(options.codeHistory === true ? [identityOf(codePage, 'github.com')] : []),
  ] as string[];
  const store = new MemoryRuleStore();
  const proofs = new FakeProofs();
  const ruleAudits: unknown[] = [];
  const listing = async (): Promise<RuleListing> => {
    const keyed = await directory.accounts.keyedList();
    return {
      ...keyed,
      signIns: keyed.signIns.map(each => ({
        ...each,
        // A terminal sign-in's history is the owner's taps into the proved sudo on this machine.
        observed:
          each.place.kind === 'terminal'
            ? [
                {
                  ...tappedFact('sudo@kirin-box', 2, identityOf(sudoPrompt(), 'sudo@kirin-box')),
                  surface: 'terminal' as const,
                },
              ]
            : history.map(identity => tappedFact('github.com', 2, identity)),
      })),
    } as RuleListing;
  };
  const rules = new SignInRuleService({
    store,
    accounts: { listing },
    proofs,
    passkeys: { any: async () => true, of: async () => true },
    devices: { label: async () => 'Pixel 9' },
    audit: { record: async entry => void ruleAudits.push(entry) },
    clock: { now: () => clock.now },
    warn: () => undefined,
  });
  await rules.load();
  const keyOf = async (account: string) =>
    (await directory.accounts.seedTarget(account).catch(() => undefined))?.key as never;
  const ledger = new SignInGrantLedger();
  const ruleGrants = new RuleSignInGrants({
    rules,
    ledger,
    keys: keyOf,
    advertised: () => options.advertised ?? true,
    stampedProject: async () => options.project,
    clock: { now: () => clock.now },
  });
  const grants = new CombinedSignInGrants(
    new PlanSignInGrants(
      {
        signInLines: () => [],
        signInLineHeld: () => false,
        lineUsed: () => undefined,
        lineStopped: async () => undefined,
      },
      keyOf,
      () => true,
      ledger,
    ),
    ruleGrants,
    ledger,
  );
  let service: InputRequestService;
  const h = {
    get service() {
      return service;
    },
    rules,
    ruleGrants,
    ledger,
    store,
    proofs,
    directory,
    writes,
    armed,
    cards,
    quietAtRaise,
    notes,
    closes,
    tells,
    rebuzzes,
    audits,
    ruleAudits,
    timers,
    clock,
    /** The ferret clicks, types, navigates or runs a script on its pages now. */
    act: () => {
      acted = clock.now;
    },
    setFacts: (next: InputTargetFacts) => {
      facts = next;
    },
  };
  service = new InputRequestService({
    target: {
      observe: async () => ({ ok: true, facts }),
      type: async (_session, _target, typed, _submit, _expected, more) => {
        armed.push(more?.armClear === true);
        options.onQueued?.(h as Harness);
        if (more?.proceed?.() === false) return 'target_changed';
        if ((options.written ?? 'typed') === 'typed') writes.push(...typed.map(value => value.text));
        return options.written ?? 'typed';
      },
      clear: async () => options.clear ?? 'moved',
      ...(options.probes === true ? { probe: async () => 'hidden' as const } : {}),
    },
    agenda: {
      raise: async (session, raised) => {
        cards.push(raised);
        if (options.actDuringRaise === true) acted = clock.now;
        quietAtRaise.push(service.quietCard(session, raised.requestId));
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, at, note) => void closes.push(`${at}: ${note}`),
      promptOf: async () => undefined,
      note: async (_session, at, _card, line) => void notes.push(`${at}: ${line}`),
    },
    notifier: { tell: async (_session, at, message) => void tells.push(`${at}: ${message}`) },
    journal: {
      publish: async (_session, event) => {
        await options.onJournal?.(event.type, h as Harness);
      },
      history: async () => [],
      quarantine: async () => undefined,
      quarantines: async () => [],
    },
    audit: new InputAuditAdapter({ record: async entry => void audits.push(entry) }),
    clock: { now: () => clock.now },
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: {
      after: async ms =>
        await new Promise<void>(resolve => {
          timers.push({ ms, fire: resolve });
        }),
    },
    sessions: { ended: async () => false, all: async () => [SESSION, OTHER] },
    values,
    quarantine: new QuarantineRegistry({ now: () => clock.now }),
    redact: async text => values.scrubAll(text),
    logins,
    hostName: 'kirin-box',
    grants,
    rebuzz: async session => void rebuzzes.push(session),
    // The ferret's last act on its pages, as the login observer would say: no act, or the moment it last acted.
    observer: {
      delivered: async () => undefined,
      tainted: (_session, _kind, since) => acted !== undefined && acted >= since,
    },
  });
  return h;
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** GitHub · kirinnee, a password sign-in at github.com, with a saved password. */
async function github(h: Harness, domains: readonly string[] = ['github.com']): Promise<SignInId> {
  await h.directory.put(
    'GITHUB',
    PutLoginEntryRequestSchema.parse({
      label: 'GitHub',
      username: USERNAME,
      password: PASSWORD,
      match: [...domains],
    }),
  );
  const signIn = (await h.directory.accounts.list()).signIns.find(each => each.account === 'GITHUB');
  if (signIn === undefined) throw new Error('no sign-in');
  return signIn.id;
}

/** The owner approved a standing rule for the sign-in from their phone, with its passkey. */
async function ruleFor(h: Harness, signIn: SignInId, over: Partial<SignInRuleDraft> = {}): Promise<SignInRuleId> {
  const { view } = await approved(
    { service: h.rules } as unknown as World,
    { signIn, fields: ['username', 'password'], ...over },
    { kind: 'owner', actor: { kind: 'device', deviceId: DEVICE } },
  );
  return view.id;
}

async function raised(h: Harness, raise: InputRaise = SIGN_IN, session = SESSION) {
  const view = await h.service.raise(session, raise);
  const request = (await h.service.list(HOST)).find(each => each.agendaItemId === view.id);
  return { view, request };
}

/** Lets what runs after a Send (not awaited by it) and the rule service's queued writes finish. */
const settled = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 10));

const ruleOnDisk = (h: Harness) => h.store.document?.rules[0];

describe('a sign-in a standing rule covers is filled under it, for any ferret (invariant 10)', () => {
  it('should type the username and the password, close the card, count the use and tell the ferret only that', async () => {
    const h = await harness();
    const rule = await ruleFor(h, await github(h));

    const { view, request } = await raised(h);
    await settled();

    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(view.state).equal('delivered');
    should(view.note).equal('Filled under a rule the owner approved in advance.');
    should(JSON.stringify(view)).not.containEql(rule);
    should(request).be.undefined();
    should(h.closes).deepEqual(['A1: Filled under your standing rule on github.com.']);
    // The notifier records `<card>: <message>`, and the message names its card itself.
    should(h.tells[0]).equal(
      'A1: A1: Ferretry filled the sign-in on %browser:app under a rule the owner approved in advance. Read the page to continue once its quarantine allows.',
    );
    should(ruleOnDisk(h)?.usage).match({ count: 1, lastSession: SESSION });
  });

  it('should fill in another session and in a sub-ferret alike, with no scope', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    for (const session of [SESSION, OTHER, `${SESSION}-child`]) {
      h.clock.now += 200_000;
      const { view } = await raised(h, SIGN_IN, session);
      should(view.state).equal('delivered');
    }
    should(h.writes.filter(text => text === PASSWORD)).have.length(3);
  });

  it('should fill only the session a session-scoped rule names, and ask in any other (no suspension)', async () => {
    const h = await harness();
    await ruleFor(h, await github(h), { scope: { kind: 'session', session: OTHER } });
    const { view, request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).match({ by: 'rule', outcome: 'did-not-apply', reason: 'out-of-scope' });
    should(ruleOnDisk(h)?.suspended).be.undefined();
    should((await raised(h, SIGN_IN, OTHER)).view.state).equal('delivered');
  });

  it('should fill a project-scoped rule only for a session stamped with that project', async () => {
    const stamped = await harness({ project: PROJECT });
    await ruleFor(stamped, await github(stamped), { scope: { kind: 'project', project: PROJECT } });
    should((await raised(stamped)).view.state).equal('delivered');
    const unstamped = await harness();
    await ruleFor(unstamped, await github(unstamped), { scope: { kind: 'project', project: PROJECT } });
    const { request } = await raised(unstamped);
    should(request?.preapproval).match({ by: 'rule', reason: 'out-of-scope' });
    should(unstamped.writes).deepEqual([]);
  });

  it('should record the rule, its revision and the sign-in in the log, and never a value (invariant 28)', async () => {
    const h = await harness();
    const signIn = await github(h);
    const rule = await ruleFor(h, signIn);
    await raised(h);
    await settled();
    const delivered = h.audits.find(entry => entry.event === 'input.delivered');
    should(delivered?.detail).match({
      by: 'rule',
      signInRule: rule,
      revision: 1,
      signIn,
      source: 'saved',
      entry: 'GITHUB',
    });
    should(delivered?.detail).not.have.property('rule');
    const everything = JSON.stringify([h.audits, h.ruleAudits, h.cards, h.notes, h.closes, h.tells, h.store.document]);
    should(everything).not.containEql(PASSWORD);
    should(JSON.stringify([h.audits, h.cards, h.notes, h.closes, h.tells])).not.containEql(USERNAME);
  });
});

describe('every check holds or nothing is typed, and the owner reads why (invariants 11, 12)', () => {
  const cases: readonly { readonly name: string; readonly facts: InputTargetFacts; readonly reason: string }[] = [
    {
      name: 'a page on http',
      facts: loginPage({ origin: 'http://github.com', secure: false }, [
        field('user', { frameOrigin: 'http://github.com' }),
        field('pass', { frameOrigin: 'http://github.com' }),
      ]),
      reason: 'not-https',
    },
    {
      name: 'a field in a frame from another site',
      facts: loginPage({}, [field('user'), field('pass', { frameOrigin: 'https://evil.example' })]),
      reason: 'frame',
    },
    { name: 'a human check', facts: loginPage({ challenge: { provider: 'recaptcha' } }), reason: 'challenge' },
  ];
  for (const each of cases)
    it(`should type nothing on ${each.name}: ${each.reason}`, async () => {
      const h = await harness();
      await ruleFor(h, await github(h));
      h.setFacts(each.facts);
      const { view, request } = await raised(h);
      should(h.writes).deepEqual([]);
      should(view.state).equal('pending');
      should(request?.preapproval).match({ by: 'rule', outcome: 'did-not-apply', reason: each.reason });
      should(ruleOnDisk(h)?.suspended).be.undefined();
    });

  it('should never pin a new password form: one outside the owner’s history is a changed form, and suspends', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    h.setFacts(loginPage({}, [field('user'), field('pass', {}, { name: 'sudo_password' })]));
    const { request } = await raised(h);
    await settled();
    should(h.writes).deepEqual([]);
    should(request?.preapproval).match({ by: 'rule', reason: 'form-changed' });
    should(ruleOnDisk(h)?.suspended?.because).equal('form-changed');
  });

  it('should refuse a rule whose passkey left the registry with no signal: checked again before the write (inv. 5)', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    h.proofs.held.clear();
    const { request } = await raised(h);
    await settled();
    should(h.writes).deepEqual([]);
    should(request?.preapproval).match({ by: 'rule', reason: 'proof-invalid' });
    should(ruleOnDisk(h)?.suspended?.because).equal('passkey-removed');
  });

  it('should ask, and suspend nothing, while the passkey registry cannot be read', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    h.proofs.broken = true;
    const { request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(request?.preapproval).match({ by: 'rule', outcome: 'did-not-apply' });
    should(request?.preapproval?.reason).be.undefined();
    should(ruleOnDisk(h)?.suspended).be.undefined();
  });

  it('should leave every raise a normal card while `sign-in-rules.1` is not advertised (invariant 32)', async () => {
    const h = await harness({ advertised: false });
    await ruleFor(h, await github(h));
    const { view, request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(h.quietAtRaise).deepEqual([false]);
    should(request?.preapproval).be.undefined();
  });
});

describe('a suspension is the owner’s to see, never the ferret’s (invariants 18, 29)', () => {
  it('should leave the ferret’s view, its agenda card and its words byte-identical to a sign-in with no rule', async () => {
    const withRule = await harness();
    await ruleFor(withRule, await github(withRule), { scope: { kind: 'session', session: OTHER } });
    const noRule = await harness();
    await github(noRule);

    const a = await raised(withRule);
    const b = await raised(noRule);
    await settled();

    should(JSON.stringify(a.view)).equal(JSON.stringify(b.view));
    should(JSON.stringify(withRule.cards)).equal(JSON.stringify(noRule.cards));
    should(withRule.notes).deepEqual(noRule.notes);
    should(withRule.notes).deepEqual([]);
    should(withRule.tells).deepEqual(noRule.tells);
    should(JSON.stringify(await withRule.service.agentView(SESSION, a.view.id, 0))).equal(
      JSON.stringify(await noRule.service.agentView(SESSION, b.view.id, 0)),
    );
  });

  it('should raise no card in the ferret’s session for a fill-caused suspension, and name no account anywhere it reads', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    h.setFacts(loginPage({}, [field('user'), field('pass', {}, { name: 'sudo_password' })]));
    await raised(h);
    await settled();
    should(ruleOnDisk(h)?.suspended?.because).equal('form-changed');
    should(h.cards).have.length(1);
    // The card's own words are the ferret's prompt; nothing the daemon adds names the account or its username.
    should(JSON.stringify([h.cards, h.notes, h.tells])).not.containEql('"GITHUB"');
    should(JSON.stringify([h.cards, h.notes, h.tells])).not.containEql(USERNAME);
    should(JSON.stringify(h.ruleAudits)).containEql('sign-in-rule-suspended');
  });
});

describe('the card is quiet while a rule fills it, and buzzes once when it does not (invariant 27)', () => {
  it('should raise the card quiet, close it with no buzz, and make no edit', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    await raised(h);
    should(h.quietAtRaise).deepEqual([true]);
    should(h.rebuzzes).deepEqual([]);
    should(h.notes).deepEqual([]);
  });

  it('should hand a miss back to the owner with exactly one buzz, and no line on the card', async () => {
    const h = await harness();
    await ruleFor(h, await github(h), { scope: { kind: 'session', session: OTHER } });
    const { view } = await raised(h);
    should(h.quietAtRaise).deepEqual([true]);
    should(h.rebuzzes).deepEqual([SESSION]);
    should(h.notes).deepEqual([]);
    should(h.service.quietCard(SESSION, '1'.padStart(32, '0'))).be.false();
    should(view.state).equal('pending');
  });
});

describe('uses are synchronous, one role per use, and kept (invariant 21)', () => {
  it('should fill only one of two raises in two sessions in one tick for a one-use rule', async () => {
    const h = await harness();
    await ruleFor(h, await github(h), { uses: 1 });
    const [one, two] = await Promise.all([raised(h, SIGN_IN, SESSION), raised(h, SIGN_IN, OTHER)]);
    await settled();
    should([one.view.state, two.view.state].sort()).deepEqual(['delivered', 'pending']);
    should(h.writes.filter(text => text === PASSWORD)).have.length(1);
    should(ruleOnDisk(h)?.usage.count).equal(1);
  });

  it('should spend a new use for a second password in one attempt, and keep the count across a restart', async () => {
    const h = await harness();
    await ruleFor(h, await github(h), { uses: 1 });
    await raised(h);
    await settled();
    h.setFacts(loginPage({ navigationId: 'loader-2' }));
    const { request } = await raised(h);
    should(request?.preapproval).match({ by: 'rule', reason: 'used-up' });
    const reread = new SignInRuleService({
      store: h.store,
      accounts: { listing: async () => ({ accounts: [], signIns: [], keys: new Map() }) },
      proofs: h.proofs,
      passkeys: { any: async () => true, of: async () => true },
      audit: { record: async () => undefined },
      clock: { now: () => h.clock.now },
      warn: () => undefined,
    });
    await reread.load();
    should(reread.fillable()[0]?.usage.count).equal(1);
  });
});

describe('a revoke, a narrowing or a script during a fill stops the write (invariants 19, 25)', () => {
  it('should type nothing and give the use back when the rule is revoked at the last step before the write', async () => {
    const h = await harness({
      onJournal: async (type, at) => {
        if (type.endsWith('delivering')) {
          const id = at.rules.fillable()[0]?.body.id;
          if (id !== undefined) await at.rules.revoke({ kind: 'owner', actor: { kind: 'host' } }, id);
        }
      },
    });
    await ruleFor(h, await github(h));
    const { view } = await raised(h);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
  });

  it('should type nothing when the rule is suspended while the write waits in the page’s queue (proceed)', async () => {
    let suspended = false;
    const h = await harness({
      onQueued: at => {
        if (suspended) return;
        suspended = true;
        // A page script on github.com from another session, landing while this write waited its turn.
        at.ruleGrants.scriptedOn('github.com');
      },
    });
    await ruleFor(h, await github(h));
    const { view } = await raised(h);
    await settled();
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(ruleOnDisk(h)?.suspended?.because).equal('scripted-origin');
  });

  it('should ask after another session’s page script on the rule’s site, and suspend it on disk (invariant 25)', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    h.ruleGrants.scriptedOn('github.com');
    const { view } = await raised(h);
    await settled();
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(ruleOnDisk(h)?.suspended?.because).equal('scripted-origin');
  });

  it('should leave a code to the owner once the code was narrowed away mid-attempt', async () => {
    const h = await harness();
    const signIn = await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED, 'Authenticator app');
    const rule = await ruleFor(h, signIn, { totp: true, totpAcknowledged: true });
    await raised(h);
    await h.rules.narrow({ kind: 'owner', actor: { kind: 'host' } }, rule, { dropTotp: true });
    h.setFacts(codePage);
    const { request } = await raised(h, CODE_RAISE);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'code-not-ticked' });
  });
});

describe('a code only with its tick, from the pinned key, as a join to the rule’s own password attempt (invariants 15, 23)', () => {
  const CODE = totpCode(SEED, SIX, NOW) as string;
  /** A rule with the code ticked for GitHub, whose account holds a seed Ferretry makes codes from. */
  async function codeRule(h: Harness, domains?: readonly string[], over: Partial<SignInRuleDraft> = {}) {
    const signIn = await github(h, domains);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED, 'Authenticator app');
    return await ruleFor(h, signIn, { totp: true, totpAcknowledged: true, ...over });
  }

  it('should fill the password page and then the code page on one use, typing the pinned key’s code', async () => {
    // The code form is in no history (a code box never is): it fills only as a join, and pins nothing.
    const h = await harness();
    const rule = await codeRule(h, undefined, { uses: 1 });
    await raised(h);
    h.setFacts(codePage);
    const { view } = await raised(h, CODE_RAISE);
    await settled();
    should(view.state).equal('delivered');
    should(h.writes).deepEqual([USERNAME, PASSWORD, CODE]);
    should(ruleOnDisk(h)?.usage.count).equal(1);
    should(h.ledger.pinned(`rule:${rule}:1`).has('totp')).be.false();
    should(JSON.stringify([view, h.audits, h.cards, h.notes, h.closes, h.tells, h.store.document])).not.containEql(
      CODE,
    );
  });

  it('should ask for a code page with no open attempt of the rule (a "confirm with 2FA" form)', async () => {
    const h = await harness();
    await codeRule(h);
    h.setFacts(codePage);
    const { view, request } = await raised(h, CODE_RAISE);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).match({ by: 'rule', reason: 'code-without-sign-in' });
    should(ruleOnDisk(h)?.suspended).be.undefined();
  });

  it('should ask for the code in another session than the one whose password the rule typed', async () => {
    const h = await harness();
    await codeRule(h);
    await raised(h, SIGN_IN, SESSION);
    h.setFacts(codePage);
    const { request } = await raised(h, CODE_RAISE, OTHER);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'code-without-sign-in' });
  });

  it('should ask for the code at another place than the password, even a login domain the rule pins', async () => {
    const h = await harness();
    await codeRule(h, ['github.com', 'login.github.com']);
    await raised(h);
    h.setFacts(
      loginPage({ origin: 'https://login.github.com', navigationId: 'loader-2' }, [
        field('otp', { frameOrigin: 'https://login.github.com' }, { type: 'text', autocomplete: 'one-time-code' }),
      ]),
    );
    const { request } = await raised(h, CODE_RAISE);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'code-without-sign-in' });
  });

  it('should ask for a page with a second code box', async () => {
    const h = await harness();
    await codeRule(h);
    await raised(h);
    h.setFacts(
      loginPage({ navigationId: 'loader-2' }, [
        field('otp', {}, { type: 'text', autocomplete: 'one-time-code' }),
        field('otp2', { backendNodeId: 14 }, { type: 'text', autocomplete: 'one-time-code' }),
      ]),
    );
    const { request } = await raised(h, {
      ...CODE_RAISE,
      fields: [
        { id: 'otp', sensitivity: 'code', element: { kind: 'ref', ref: 'e3' } },
        { id: 'otp2', sensitivity: 'code', element: { kind: 'ref', ref: 'e4' } },
      ],
    });
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'field-not-covered' });
  });

  it('should ask for the code under a rule without the code tick', async () => {
    const h = await harness();
    const signIn = await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED, 'Authenticator app');
    await ruleFor(h, signIn);
    await raised(h);
    h.setFacts(codePage);
    const { request } = await raised(h, CODE_RAISE);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'code-not-ticked' });
  });

  it('should suspend, and type no code, after a page script on the place between the password and the code', async () => {
    const h = await harness();
    await codeRule(h);
    await raised(h);
    h.ruleGrants.scriptedOn('github.com');
    h.setFacts(codePage);
    const { view } = await raised(h, CODE_RAISE);
    await settled();
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(view.state).equal('pending');
    should(ruleOnDisk(h)?.suspended?.because).equal('scripted-origin');
  });

  it('should fill a code form that IS in the history as an ordinary step after the rule’s password', async () => {
    const h = await harness({ codeHistory: true });
    await codeRule(h);
    await raised(h);
    h.setFacts(codePage);
    should((await raised(h, CODE_RAISE)).view.state).equal('delivered');
    should(h.writes).deepEqual([USERNAME, PASSWORD, CODE]);
  });
});

describe('hold, clear and arm apply to rule fills (invariant 26)', () => {
  it('should arm the pagehide clear before a page password is typed', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    await raised(h);
    should(h.armed).deepEqual([true]);
  });

  for (const clear of ['cleared', 'unknown'] as const)
    it(`should suspend the rule (did-not-move-on) when the clear answers ${clear}`, async () => {
      const h = await harness({ clear });
      await ruleFor(h, await github(h));
      await raised(h);
      // Past the write's own hold: only the clear's own hold (kept on `unknown`) can still hold the page.
      h.clock.now += 130_000;
      for (const timer of h.timers) timer.fire();
      await settled();
      should(ruleOnDisk(h)?.suspended?.because).equal('did-not-move-on');
      should(h.service.pageHeld(SESSION, ['app']) !== undefined).equal(clear === 'unknown');
    });
});

describe('the ferret reads no state a card with no rule never shows, even mid-fill (secrev-1282b F1)', () => {
  /** What the ferret reads of a card no rule was ever about: raised, then nobody answered it. */
  async function noRuleView() {
    const h = await harness();
    await github(h);
    const { view } = await raised(h);
    return JSON.stringify(await h.service.agentView(SESSION, view.id, 0));
  }

  it('should read the card as pending, word for word, while a rule fill is refused at its last step', async () => {
    let during: string | undefined;
    const h = await harness({
      onJournal: async (type, at) => {
        if (!type.endsWith('delivering')) return;
        // A concurrent input_wait at the last step before the write, then the owner revokes the rule.
        during = JSON.stringify(await at.service.agentView(SESSION, 'A1' as AgendaId, 0));
        const id = at.rules.fillable()[0]?.body.id;
        if (id !== undefined) await at.rules.revoke({ kind: 'owner', actor: { kind: 'host' } }, id);
      },
    });
    await ruleFor(h, await github(h));
    const { view } = await raised(h);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    const expected = await noRuleView();
    should(during).equal(expected);
    should(JSON.stringify(await h.service.agentView(SESSION, view.id, 0))).equal(expected);
  });

  it('should read the card as pending while the rule’s proof is being checked again, and after it fails', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    let open: () => void = () => undefined;
    const checking = new Promise<void>(resolve => (open = resolve));
    let reached: () => void = () => undefined;
    const atCheck = new Promise<void>(resolve => (reached = resolve));
    const verify = h.proofs.verify.bind(h.proofs);
    h.proofs.verify = async (proof, challenge) => {
      reached();
      await checking;
      return await verify(proof, challenge);
    };

    const raising = raised(h);
    await atCheck;
    const during = JSON.stringify(await h.service.agentView(SESSION, 'A1' as AgendaId, 0));
    h.proofs.held.clear();
    open();
    const { view } = await raising;

    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(during).equal(await noRuleView());
  });

  it('should show the filled card once the fill really ended, to a ferret that was already waiting', async () => {
    let waiting: Promise<unknown> | undefined;
    const h = await harness({
      onJournal: async (type, at) => {
        if (type.endsWith('delivering')) waiting = at.service.agentView(SESSION, 'A1' as AgendaId, 60_000);
      },
    });
    await ruleFor(h, await github(h));
    await raised(h);
    should(await waiting).match({ state: 'delivered', note: 'Filled under a rule the owner approved in advance.' });
  });
});

describe('a write that could not say whether it typed is cleared, held and suspends (secrev-1282b F2)', () => {
  it('should keep the page held past the write’s own hold, run the clear and suspend the rule', async () => {
    const h = await harness({ written: 'uncertain', clear: 'moved' });
    await ruleFor(h, await github(h));
    const { view } = await raised(h);
    await settled();
    should(view.state).equal('refused');
    should(ruleOnDisk(h)?.suspended?.because).equal('did-not-move-on');
    // The clear is scheduled, and until it answers the page stays held, however long past the write's own hold.
    should(h.timers).have.length(1);
    h.clock.now += 600_000;
    should(h.service.pageHeld(SESSION, ['app'])).not.be.undefined();
    for (const timer of h.timers) timer.fire();
    await settled();
    should(h.service.pageHeld(SESSION, ['app'])).be.undefined();
  });
});

describe('no rule fills while an agent script runs anywhere (secrev-1282a M2)', () => {
  it('should type nothing while another session’s script is still running, and fill once it ended', async () => {
    const h = await harness();
    await ruleFor(h, await github(h));
    // Another session's browser_eval is in flight, on a page whose origin is not known yet.
    const ended = h.ruleGrants.running();
    const { view } = await raised(h);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(ruleOnDisk(h)?.suspended).be.undefined();
    ended();
    h.clock.now += 1_000;
    should((await raised(h, SIGN_IN, OTHER)).view.state).equal('delivered');
  });
});

describe('a rule’s code joins only the next step of its own sign-in (delta F2)', () => {
  const CODE = totpCode(SEED, SIX, NOW) as string;
  async function codeRule(h: Harness) {
    const signIn = await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED, 'Authenticator app');
    return await ruleFor(h, signIn, { totp: true, totpAcknowledged: true });
  }

  it('should fill the straight flow: the password page, then the code page that tab navigated to', async () => {
    const h = await harness();
    await codeRule(h);
    await raised(h);
    h.setFacts(codePage);
    should((await raised(h, CODE_RAISE)).view.state).equal('delivered');
    should(h.writes).deepEqual([USERNAME, PASSWORD, CODE]);
  });

  it('should ask for a lone code box in another tab of the same site (a "confirm with 2FA" form)', async () => {
    const h = await harness();
    await codeRule(h);
    await raised(h);
    h.setFacts({ ...codePage, pageId: 'page-2' });
    const { request } = await raised(h, { ...CODE_RAISE, target: { kind: 'browser', key: 'other' } });
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'code-without-sign-in' });
  });

  it('should ask once the ferret clicked, typed, navigated or ran a script after the password', async () => {
    const h = await harness();
    await codeRule(h);
    await raised(h);
    h.act();
    h.setFacts(codePage);
    const { request } = await raised(h, CODE_RAISE);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'code-without-sign-in' });
  });

  it('should ask when the tab never moved on from the password page (the same document)', async () => {
    const h = await harness();
    await codeRule(h);
    await raised(h);
    h.setFacts({ ...codePage, navigationId: 'loader-1' });
    const { request } = await raised(h, CODE_RAISE);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(request?.preapproval).match({ by: 'rule', reason: 'code-without-sign-in' });
  });
});

describe('a refusal the ferret can cause shows it nothing a card with no rule would not (delta F3, F4)', () => {
  it('should refuse before the page is held when a script is running, so the ferret’s reads never meet a hold', async () => {
    const journal: string[] = [];
    const h = await harness({ onJournal: type => void journal.push(type) });
    await ruleFor(h, await github(h));
    const ended = h.ruleGrants.running();
    const { view } = await raised(h);
    ended();
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(h.service.pageHeld(SESSION, ['app'])).be.undefined();
    // The attempt never reached the write's journal entry: nothing took the page from the ferret.
    should(journal.some(type => type.endsWith('delivering'))).be.false();
  });

  it('should keep reading the lock the card was raised with after a late refusal, as with no rule', async () => {
    const revokeAtDelivering = async (type: string, at: Harness) => {
      if (!type.endsWith('delivering')) return;
      const id = at.rules.fillable()[0]?.body.id;
      if (id !== undefined) await at.rules.revoke({ kind: 'owner', actor: { kind: 'host' } }, id);
    };
    // The ferret acts while the card is raised: the write's look works out a longer lock than the raise's.
    const h = await harness({ probes: true, actDuringRaise: true, onJournal: revokeAtDelivering });
    await ruleFor(h, await github(h));
    const { view } = await raised(h);
    const noRule = await harness({ probes: true, actDuringRaise: true });
    await github(noRule);
    const plain = await raised(noRule);

    should(view.state).equal('pending');
    should(view.lockSeconds).equal(plain.view.lockSeconds);
    // The request itself keeps the longer lock (a card never shortens): only the ferret's reading is the raise's.
    const [request] = await h.service.list(HOST);
    should(request?.lock?.seconds).be.above(view.lockSeconds ?? 0);
  });
});

// R3c-T (owner decision !A197): a terminal rule fills sudo, su or doas the KERNEL proved, through the guarded write.
describe('a terminal rule types the password into a proved setuid sudo, and nowhere else (invariant 24)', () => {
  /** Kirin's sudo password on this machine, as a sign-in at `sudo@kirin-box`. */
  async function sudoSignIn(h: Harness): Promise<SignInId> {
    await h.directory.put(
      'KIRIN',
      PutLoginEntryRequestSchema.parse({ label: 'Kirin', password: PASSWORD, match: ['sudo@kirin-box'] }),
    );
    const signIn = (await h.directory.accounts.list()).signIns.find(each => each.account === 'KIRIN');
    if (signIn === undefined) throw new Error('no sign-in');
    return signIn.id;
  }

  const sudoRule = async (h: Harness): Promise<SignInRuleId> =>
    await ruleFor(h, await sudoSignIn(h), { fields: ['password'] });

  it('should type the password once into the proved sudo, with Enter, close the card and log it by the rule', async () => {
    // Arrange
    const h = await harness();
    h.setFacts(sudoPrompt());
    const rule = await sudoRule(h);

    // Act
    const { view, request } = await raised(h, SUDO_RAISE);
    await settled();

    // Assert
    should(h.writes).deepEqual([PASSWORD]);
    should(h.armed).deepEqual([false]);
    should(view.state).equal('delivered');
    should(view.note).equal('Filled under a rule the owner approved in advance.');
    should(request).be.undefined();
    should(h.quietAtRaise).deepEqual([true]);
    should(ruleOnDisk(h)?.usage).match({ count: 1, lastSession: SESSION });
    should(h.audits.find(entry => entry.event === 'input.delivered')?.detail).match({
      by: 'rule',
      signInRule: rule,
      revision: 1,
      entry: 'KIRIN',
    });
    should(JSON.stringify([h.audits, h.ruleAudits, h.cards, h.notes, h.closes, h.tells])).not.containEql(PASSWORD);
  });

  const misses: readonly { readonly name: string; readonly facts: TerminalFacts; readonly reason?: string }[] = [
    { name: 'a sudo not running setuid root', facts: sudoPrompt({ trustedProgram: undefined }), reason: 'not-system' },
    { name: 'a prompt echoing what is typed', facts: sudoPrompt({ echo: 'on' }), reason: 'not-proved' },
    {
      name: 'a program not proved to ask for secrets',
      facts: sudoPrompt({ recognisedConsumer: false }),
      reason: 'not-proved',
    },
    // No proved program, so no `sudo@kirin-box` at all: no rule is even tried, and the card is a plain one.
    {
      name: 'a shell that only renamed itself sudo',
      facts: sudoPrompt({ program: undefined, trustedProgram: undefined, recognisedConsumer: false }),
    },
    { name: 'a prompt not in line mode (a relay)', facts: sudoPrompt({ canonical: false }) },
  ];
  for (const each of misses)
    it(`should type nothing into ${each.name}, suspend nothing, and leave the owner's card`, async () => {
      // Arrange
      const h = await harness();
      h.setFacts(each.facts);
      await sudoRule(h);

      // Act
      const { view, request } = await raised(h, SUDO_RAISE);
      await settled();

      // Assert
      should(h.writes).deepEqual([]);
      should(view.state).equal('pending');
      if (each.reason === undefined) should(request?.preapproval).be.undefined();
      else should(request?.preapproval).match({ by: 'rule', outcome: 'did-not-apply', reason: each.reason });
      should(ruleOnDisk(h)?.suspended).be.undefined();
      should(ruleOnDisk(h)?.usage.count).equal(0);
    });

  it('should type nothing into su under a rule for sudo: the proved program picks the key', async () => {
    // Arrange — su is proved, but the rule is pinned to sudo@kirin-box
    const h = await harness();
    h.setFacts(sudoPrompt({ program: 'su', foreground: { pid: 4300, pgid: 4300, comm: 'su', argv: 'su -' } }));
    await sudoRule(h);

    // Act
    const { view } = await raised(h, SUDO_RAISE);

    // Assert
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
  });

  it('should type nothing when the rule is revoked inside the terminal’s turn, right before the guarded write', async () => {
    // Arrange
    let revoked = false;
    const h = await harness({
      onQueued: at => {
        if (revoked) return;
        revoked = true;
        const id = at.rules.fillable()[0]?.body.id;
        // The owner's one-tap revoke lands between the last look and the tmux write: `proceed()` is asked after it.
        if (id !== undefined) void at.rules.revoke({ kind: 'owner', actor: { kind: 'host' } }, id);
      },
    });
    h.setFacts(sudoPrompt());
    await sudoRule(h);

    // Act
    const { view } = await raised(h, SUDO_RAISE);
    await settled();

    // Assert
    should(revoked).be.true();
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(h.store.document?.rules).have.length(0);
  });

  it('should type nothing when the rule is revoked at the last step before the write', async () => {
    // Arrange
    const h = await harness({
      onJournal: async (type, at) => {
        if (!type.endsWith('delivering')) return;
        const id = at.rules.fillable()[0]?.body.id;
        if (id !== undefined) await at.rules.revoke({ kind: 'owner', actor: { kind: 'host' } }, id);
      },
    });
    h.setFacts(sudoPrompt());
    await sudoRule(h);

    // Act
    const { view } = await raised(h, SUDO_RAISE);

    // Assert
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
  });

  it('should still fill after a page script whose origin could not be read: no page script reaches the terminal', async () => {
    // Arrange
    const h = await harness();
    h.setFacts(sudoPrompt());
    await sudoRule(h);
    h.ruleGrants.scriptedOn(undefined);
    await settled();

    // Act
    const { view } = await raised(h, SUDO_RAISE);

    // Assert
    should(h.writes).deepEqual([PASSWORD]);
    should(view.state).equal('delivered');
    should(ruleOnDisk(h)?.suspended).be.undefined();
  });

  it('should leave the ferret’s view, its agenda card and its words byte-identical to sudo with no rule (invariant 29)', async () => {
    for (const facts of [
      sudoPrompt({ trustedProgram: undefined }),
      sudoPrompt({ echo: 'on' }),
      sudoPrompt({ program: undefined, trustedProgram: undefined, recognisedConsumer: false }),
    ]) {
      // Arrange
      const withRule = await harness();
      withRule.setFacts(facts);
      await sudoRule(withRule);
      const noRule = await harness();
      noRule.setFacts(facts);
      await sudoSignIn(noRule);

      // Act
      const a = await raised(withRule, SUDO_RAISE);
      const b = await raised(noRule, SUDO_RAISE);
      await settled();

      // Assert
      should(withRule.writes).deepEqual([]);
      should(JSON.stringify(a.view)).equal(JSON.stringify(b.view));
      should(JSON.stringify(withRule.cards)).equal(JSON.stringify(noRule.cards));
      should(withRule.notes).deepEqual(noRule.notes);
      should(withRule.tells).deepEqual(noRule.tells);
      should(JSON.stringify(await withRule.service.agentView(SESSION, a.view.id, 0))).equal(
        JSON.stringify(await noRule.service.agentView(SESSION, b.view.id, 0)),
      );
    }
  });
});
