import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputRaise,
  type InputTargetFacts,
  PutLoginEntryRequestSchema,
  type SignInId,
  TASK_PLAN_MISS_AGENT_NOTE,
} from '@ferretry/protocol';
import should from 'should';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { InputAuditAdapter } from '../../../src/lib/input-requests/audit-adapter.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputLoginAdapter } from '../../../src/lib/input-requests/login-adapter.ts';
import type { InputCaller, InputCard, TypeOptions, TypeResult } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { LoginDirectory, LoginVault, totpCode } from '../../../src/lib/secrets/index.ts';
import type { ClearJob, ClearOutcome } from '../../../src/lib/sign-in-grants/clear.ts';
import { type PlanGrantLines, PlanSignInGrants } from '../../../src/lib/sign-in-grants/plans.ts';
import type { ApprovedSignInLine } from '../../../src/lib/task-plans/service.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments, plantSeed } from '../runtime/mounts/support.ts';

/**
 * R3a-4, TASK PLAN FILLS through the REAL input service and the REAL account store (fake cipher, memory files): a card a
 * ticked plan line covers is filled under it, only after every check holds on what the daemon saw, only with what the
 * line binds, only within its uses; anything less types nothing and leaves the owner's card with the line's reason.
 */

const SESSION = 'mvv6b4qw-49d0158d';
const OTHER = 'mvv6b4qw-49d0158e';
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const PLAN = 'ab'.repeat(16);
const PASSWORD = 'correct-horse-battery-staple';
const USERNAME = 'kirinnee';
const SEED = 'JBSWY3DPEHPK3PXP';
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

const sudoPrompt = (
  over: Partial<Extract<InputTargetFacts, { readonly kind: 'terminal' }>> = {},
): InputTargetFacts => ({
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

const SIGN_IN: InputRaise = {
  target: { kind: 'browser', key: 'app' },
  prompt: 'GitHub wants a login',
  fields: [
    { id: 'user', sensitivity: 'plain', element: { kind: 'ref', ref: 'e1' } },
    { id: 'pass', sensitivity: 'secret', element: { kind: 'ref', ref: 'e2' } },
  ],
  submit: 'owner-default',
};

interface Options {
  facts?: InputTargetFacts;
  scripted?: boolean;
  enabled?: boolean;
  written?: TypeResult;
  clear?: ClearOutcome;
  session?: string;
  /** Runs at each look at the target, numbered from 1 (the raise's look, then the write's). */
  onLook?: (look: number, h: { setScripted(next: boolean): void }) => void;
  /** Runs as each journal event is published: `delivering` is the last step before the write. */
  onJournal?: (type: string) => void;
  /** Runs while the card is being raised, before the request is held. */
  onRaise?: () => void;
}

function harness(options: Options = {}) {
  const writes: string[] = [];
  const typeOptions: (TypeOptions | undefined)[] = [];
  const submits: boolean[] = [];
  const delivered: (string | undefined)[] = [];
  const heldDuringClear: boolean[] = [];
  const sinks: string[] = [];
  const cards: InputCard[] = [];
  const quietAtRaise: boolean[] = [];
  const audits: AuditEntry[] = [];
  const clears: ClearJob[] = [];
  const timers: { ms: number; fire: () => void }[] = [];
  const lines: ApprovedSignInLine[] = [];
  const used: string[] = [];
  const stopped: string[] = [];
  let facts = options.facts ?? loginPage();
  let scripted = options.scripted === true;
  let enabled = options.enabled ?? true;
  let looks = 0;
  let card = 1;
  let id = 1;
  let clockAt = NOW;
  const clock = { now: () => clockAt };
  const values = new EphemeralValues(clock);
  const index = new MemoryLoginIndex();
  const sealed = new MemorySecretDocuments();
  const cipher = new FakeSecretCipher();
  const directory = new LoginDirectory(index, sealed, cipher, { now: () => new Date(NOW).toISOString() });
  const logins = new InputLoginAdapter(directory, new LoginVault(index, sealed, cipher));
  const plans: PlanGrantLines = {
    signInLines: session => lines.filter(line => line.sessionId === session),
    signInLineHeld: (planId, line) => lines.some(each => each.planId === planId && each.line === line),
    lineUsed: (planId, line) => {
      used.push(`${planId}:${String(line)}`);
      const at = lines.findIndex(each => each.planId === planId && each.line === line);
      const held = lines[at] as ApprovedSignInLine;
      const remaining = held.remaining - 1;
      lines[at] = { ...held, remaining, state: remaining === 0 ? 'used-up' : 'approved' };
    },
    lineStopped: async (planId, line, because) => {
      stopped.push(`${String(line)}:${because}`);
      const at = lines.findIndex(each => each.planId === planId && each.line === line);
      lines[at] = { ...(lines[at] as ApprovedSignInLine), state: 'stopped', because };
    },
  };
  const grants = new PlanSignInGrants(
    plans,
    async account => (await directory.accounts.seedTarget(account).catch(() => undefined))?.key,
    () => enabled,
  );
  let service: InputRequestService;
  service = new InputRequestService({
    target: {
      observe: async () => {
        looks += 1;
        options.onLook?.(looks, {
          setScripted: next => {
            scripted = next;
          },
        });
        return { ok: true, facts };
      },
      type: async (_session, _target, typed, submit, _expected, more) => {
        typeOptions.push(more);
        submits.push(submit);
        if ((options.written ?? 'typed') === 'typed') writes.push(...typed.map(value => value.text));
        return options.written ?? 'typed';
      },
      clear: async (_session, _target, job) => {
        clears.push(job);
        // The page must still be held from the ferret while its fields are checked and emptied.
        heldDuringClear.push(service.pageHeld(options.session ?? SESSION, ['app']) !== undefined);
        return options.clear ?? 'moved';
      },
    },
    agenda: {
      raise: async (_session, raised) => {
        cards.push(raised);
        options.onRaise?.();
        quietAtRaise.push(service.quietCard(options.session ?? SESSION, raised.requestId));
        sinks.push(JSON.stringify(raised));
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, _id, note) => void sinks.push(`closed: ${note}`),
      promptOf: async () => undefined,
      note: async (_session, at, _card, line) => void sinks.push(`noted ${at}: ${line}`),
    },
    notifier: { tell: async (_session, at, message) => void sinks.push(`${at}: ${message}`) },
    journal: {
      publish: async (_session, event) => {
        options.onJournal?.(event.type);
        sinks.push(JSON.stringify(event));
      },
      history: async () => [],
      quarantine: async (_session, event) => void sinks.push(JSON.stringify(event)),
      quarantines: async () => [],
    },
    audit: new InputAuditAdapter({
      record: async entry => {
        audits.push(entry);
        sinks.push(JSON.stringify(entry));
      },
    }),
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: {
      after: async ms =>
        await new Promise<void>(resolve => {
          timers.push({ ms, fire: resolve });
        }),
    },
    sessions: { ended: async () => false, all: async () => [SESSION, OTHER] },
    values,
    quarantine: new QuarantineRegistry(clock),
    redact: async text => values.scrubAll(text),
    logins,
    hostName: 'kirin-box',
    grants,
    observer: {
      delivered: async delivery => void delivered.push(delivery.by),
      tainted: () => scripted,
    },
  });
  const everything = async (): Promise<string> =>
    [...sinks, JSON.stringify(await service.list(HOST)), JSON.stringify(lines)].join('\n');
  return {
    service,
    grants,
    writes,
    typeOptions,
    submits,
    delivered,
    heldDuringClear,
    sinks,
    cards,
    quietAtRaise,
    audits,
    clears,
    timers,
    lines,
    used,
    stopped,
    directory,
    everything,
    setFacts: (next: InputTargetFacts) => {
      facts = next;
    },
    setScripted: (next: boolean) => {
      scripted = next;
    },
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    advance: (ms: number) => {
      clockAt += ms;
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** GitHub · kirinnee, a password sign-in at github.com, with a saved password. */
async function github(h: Harness, label = 'GITHUB', match: readonly string[] = ['github.com']): Promise<SignInId> {
  await h.directory.put(
    label,
    PutLoginEntryRequestSchema.parse({ label: 'GitHub', username: USERNAME, password: PASSWORD, match: [...match] }),
  );
  return await signInOf(h, label);
}

async function signInOf(h: Harness, account: string): Promise<SignInId> {
  const listing = await h.directory.accounts.list();
  const signIn = listing.signIns.find(each => each.account === account);
  if (signIn === undefined) throw new Error('no sign-in');
  return signIn.id;
}

/** The owner ticked line 0 for this sign-in (as the plan service hands it over after the passkey commit). */
async function approve(h: Harness, signIn: SignInId, over: Partial<ApprovedSignInLine> = {}): Promise<void> {
  const listing = await h.directory.accounts.list();
  const held = listing.signIns.find(each => each.id === signIn);
  if (held === undefined) throw new Error('no sign-in');
  const key = (await h.directory.accounts.seedTarget(held.account)).key;
  h.lines.push({
    planId: PLAN,
    sessionId: SESSION,
    line: 0,
    kind: held.place.kind === 'site' ? 'sign-in' : 'terminal-sign-in',
    state: 'approved',
    signIn,
    fields: held.place.kind === 'site' ? ['password', 'username'] : ['password'],
    remaining: 1,
    pins: {
      accountKey: key as ApprovedSignInLine['pins']['accountKey'],
      placeKeys: held.place.kind === 'site' ? [...held.place.domains] : [`${held.place.tool}@${held.place.host}`],
      ...(held.recipeVersion === undefined ? {} : { recipeVersion: held.recipeVersion }),
    },
    expiresAt: NOW + 7_200_000,
    ...over,
  });
}

async function raised(h: Harness, raise: InputRaise = SIGN_IN, session = SESSION) {
  const view = await h.service.raise(session, raise);
  const request = (await h.service.list(HOST)).find(each => each.agendaItemId === view.id);
  return { view, request };
}

/** Lets what runs after a Send (not awaited by it) finish. */
const settled = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 10));

describe('a covered sign-in is filled under the plan line', () => {
  it('should type the username and the password, close the card and spend one use', async () => {
    const h = harness();
    await approve(h, await github(h));

    const { view, request } = await raised(h);

    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(view.state).equal('delivered');
    should(view.note).equal('Filled under your task plan.');
    should(request).be.undefined();
    should(h.used).deepEqual([`${PLAN}:0`]);
    should(h.lines[0]?.state).equal('used-up');
    should(h.sinks).containEql('closed: Filled under your task plan (line 1) on github.com.');
  });

  it('should raise the card quiet while it is filled, and let it go once it is closed', async () => {
    const h = harness();
    await approve(h, await github(h));
    const { view } = await raised(h);
    should(h.quietAtRaise).deepEqual([true]);
    should(h.service.quietCard(SESSION, '1'.padStart(32, '0'))).be.false();
    should(view.state).equal('delivered');
  });

  it('should arm the pagehide clear for a page password, and press Enter unless the ferret submits itself', async () => {
    const h = harness();
    await approve(h, await github(h));
    await raised(h);
    should(h.typeOptions[0]?.armClear).be.true();
  });

  it('should record the plan, its line and the sign-in in the log, and never a value', async () => {
    const h = harness();
    const signIn = await github(h);
    await approve(h, signIn);
    await raised(h);
    await settled();

    const delivered = h.audits.find(entry => entry.event === 'input.delivered');
    should(delivered?.detail).match({ by: 'plan', plan: PLAN, line: 0, signIn, source: 'saved', entry: 'GITHUB' });
    const all = await h.everything();
    should(all).not.containEql(PASSWORD);
    should(JSON.stringify(h.audits)).not.containEql(USERNAME);
  });
});

describe('every check holds or nothing is typed (the owner is asked as usual)', () => {
  const cases: readonly {
    readonly name: string;
    readonly facts?: InputTargetFacts;
    readonly raise?: InputRaise;
    readonly scripted?: boolean;
    readonly reason: string;
  }[] = [
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
    {
      name: 'a password going into a text box',
      facts: loginPage({}, [field('user'), field('pass', {}, { type: 'text' })]),
      reason: 'password-field',
    },
    {
      name: 'a covered password box',
      facts: loginPage({}, [field('user'), field('pass', { covered: true })]),
      reason: 'password-field',
    },
    {
      name: 'a hidden username box',
      facts: loginPage({}, [field('user', { visible: false }), field('pass')]),
      reason: 'field-hidden',
    },
    {
      name: 'a human check on the page',
      facts: loginPage({ challenge: { provider: 'recaptcha' } }),
      reason: 'challenge',
    },
    { name: 'a page script the ferret ran earlier in the session', scripted: true, reason: 'scripted' },
    {
      name: 'the ferret naming another account',
      raise: { ...SIGN_IN, secretHint: 'GITLAB' },
      reason: 'ferret-named-another',
    },
    {
      name: 'a private value on the card',
      raise: {
        ...SIGN_IN,
        fields: [...(SIGN_IN.fields ?? []), { id: 'pin', sensitivity: 'private', element: { kind: 'ref', ref: 'e3' } }],
      },
      facts: loginPage({}, [field('user'), field('pass'), field('pin')]),
      reason: 'field-not-covered',
    },
    {
      name: 'a code the line did not tick',
      raise: {
        ...SIGN_IN,
        fields: [...(SIGN_IN.fields ?? []), { id: 'otp', sensitivity: 'code', element: { kind: 'ref', ref: 'e3' } }],
      },
      facts: loginPage({}, [
        field('user'),
        field('pass'),
        field('otp', {}, { type: 'text', autocomplete: 'one-time-code' }),
      ]),
      reason: 'code-not-ticked',
    },
  ];

  for (const each of cases)
    it(`should type nothing on ${each.name}, and say why to the owner only (${each.reason})`, async () => {
      const h = harness({
        ...(each.facts === undefined ? {} : { facts: each.facts }),
        scripted: each.scripted === true,
      });
      await approve(h, await github(h));

      const { view, request } = await raised(h, each.raise ?? SIGN_IN);

      should(h.writes).deepEqual([]);
      should(view.state).equal('pending');
      should(request?.preapproval).deepEqual({
        by: 'plan',
        plan: PLAN,
        line: 0,
        outcome: 'did-not-apply',
        reason: each.reason,
      });
      // The ferret reads one sentence for every reason (a captcha keeps its own note: the ferret hands it to the owner).
      if (each.reason === 'challenge') should(view.note).startWith('The page is showing a captcha');
      else should(view.note).equal(`${TASK_PLAN_MISS_AGENT_NOTE} Waiting for the owner on ${view.id}.`);
      should(JSON.stringify(view)).not.containEql(each.reason);
      should(h.used).deepEqual([]);
      // The card is the owner's again, with the same words whatever the reason.
      should(h.sinks).containEql(`noted ${view.id}: A task plan line didn't apply here, so you're asked as usual.`);
      const missed = h.audits.find(
        entry => entry.event === 'input.requested' && entry.detail?.preapproval !== undefined,
      );
      should(missed?.detail).match({ preapproval: 'did-not-apply', plan: PLAN, line: 0, because: each.reason });
    });

  it('should never fill a look-alike host, a parent domain or a site’s match-only host', async () => {
    for (const origin of ['https://github.com.evil.example', 'https://evilgithub.com', 'https://gist.github.com']) {
      const h = harness({
        facts: loginPage({ origin }, [field('user', { frameOrigin: origin }), field('pass', { frameOrigin: origin })]),
      });
      await approve(h, await github(h));
      const { view, request } = await raised(h);
      should(h.writes).deepEqual([]);
      should(view.state).equal('pending');
      // The plan was not about this place at all: the card is the usual one, and says nothing of the plan.
      should(request?.preapproval).be.undefined();
      should(h.quietAtRaise).deepEqual([false]);
    }
  });

  it('should not fill at a host the sign-in names only as a site it is for (a match host, not a login domain)', async () => {
    const origin = 'https://gist.github.com';
    const h = harness({
      facts: loginPage({ origin }, [field('user', { frameOrigin: origin }), field('pass', { frameOrigin: origin })]),
    });
    await h.directory.put(
      'GITHUB',
      PutLoginEntryRequestSchema.parse({
        label: 'GitHub',
        username: USERNAME,
        password: PASSWORD,
        match: ['github.com', 'gist.github.com'],
        domains: ['github.com'],
      }),
    );
    await approve(h, await signInOf(h, 'GITHUB'));
    should(h.lines[0]?.pins.placeKeys).deepEqual(['github.com']);
    const { view, request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).be.undefined();
  });

  it('should fill nothing while the daemon does not advertise task plans (the app ships first)', async () => {
    const h = harness({ enabled: false });
    await approve(h, await github(h));
    const { view, request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).be.undefined();
    should(h.quietAtRaise).deepEqual([false]);
  });

  it('should never fill another session’s card, a sub-ferret’s included', async () => {
    for (const session of [OTHER, `${SESSION}-child`]) {
      const h = harness({ session });
      await approve(h, await github(h));
      const { view } = await raised(h, SIGN_IN, session);
      should(h.writes).deepEqual([]);
      should(view.state).equal('pending');
    }
  });
});

describe('the form and the place are pinned', () => {
  it('should pin the form at the first fill, and stop the line when a later fill finds another one', async () => {
    const h = harness();
    await approve(h, await github(h), { remaining: 2 });
    await raised(h);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);

    h.setFacts(loginPage({ navigationId: 'loader-2' }, [field('user'), field('pass', {}, { name: 'pwd' })]));
    const { view, request } = await raised(h);

    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(view.state).equal('pending');
    should(request?.preapproval?.reason).equal('form-changed');
    should(h.stopped).deepEqual(['0:form-changed']);
  });

  it('should fill a sign-in with history only on a form it has history with', async () => {
    const h = harness();
    const signIn = await github(h);
    await approve(h, signIn);
    const line = h.lines[0] as ApprovedSignInLine;
    h.lines[0] = { ...line, pins: { ...line.pins, identities: ['0123456789abcdef'] } };
    const { request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(request?.preapproval?.reason).equal('form-changed');
  });

  it('should stop the line when the sign-in’s login domains change after the owner approved it', async () => {
    const h = harness();
    const signIn = await github(h);
    await approve(h, signIn);
    await h.directory.put(
      'GITHUB',
      PutLoginEntryRequestSchema.parse({ label: 'GitHub', match: ['github.com', 'gh.example'] }),
    );
    const { request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(request?.preapproval?.reason).equal('place-changed');
    should(h.stopped).deepEqual(['0:place-changed']);
  });

  it('should say a spent or stopped line did not apply, and fill nothing', async () => {
    const h = harness();
    await approve(h, await github(h), { state: 'used-up', remaining: 0 });
    const { request } = await raised(h);
    should(h.writes).deepEqual([]);
    should(request?.preapproval?.reason).equal('used-up');
    // A spent line is not in force: the card was never quiet.
    should(h.quietAtRaise).deepEqual([false]);
  });
});

describe('uses are spent synchronously', () => {
  it('should fill exactly one of two raises in one tick under a one-use line', async () => {
    const h = harness();
    await approve(h, await github(h));
    const [first, second] = await Promise.all([
      h.service.raise(SESSION, SIGN_IN),
      h.service.raise(SESSION, { ...SIGN_IN, target: { kind: 'browser', key: 'app2' } }),
    ]);
    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should([first.state, second.state].sort()).deepEqual(['delivered', 'pending']);
    should(h.used).deepEqual([`${PLAN}:0`]);
  });

  it('should give the use back when nothing was typed, and spend it when the write may have landed', async () => {
    const refused = harness({ written: 'target_changed' });
    await approve(refused, await github(refused));
    await raised(refused).catch(() => undefined);
    should(refused.used).deepEqual([]);

    const uncertain = harness({ written: 'uncertain' });
    await approve(uncertain, await github(uncertain));
    await raised(uncertain).catch(() => undefined);
    should(uncertain.used).deepEqual([`${PLAN}:0`]);
  });
});

describe('a code Ferretry makes is typed only with its tick, and never returned', () => {
  const CODE_RAISE: InputRaise = {
    target: { kind: 'browser', key: 'app' },
    prompt: 'GitHub wants the 2FA code',
    fields: [{ id: 'otp', sensitivity: 'code', element: { kind: 'ref', ref: 'e3' } }],
    submit: 'owner-default',
  };
  const codePage = loginPage({}, [field('otp', {}, { type: 'text', autocomplete: 'one-time-code' })]);
  const SIX = { algorithm: 'SHA1', digits: 6, period: 30 } as const;

  it('should leave a code card under a line without the code tick to the owner', async () => {
    const h = harness({ facts: codePage });
    const signIn = await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED, 'Authenticator app');
    await approve(h, signIn);
    const { request } = await raised(h, CODE_RAISE);
    should(h.writes).deepEqual([]);
    should(request?.preapproval?.reason).equal('code-not-ticked');
  });

  it('should type the code with the tick, and keep it out of every result, record, card and log', async () => {
    const h = harness({ facts: codePage });
    const signIn = await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED, 'Authenticator app');
    await approve(h, signIn, { fields: ['password', 'totp', 'username'] });
    const code = totpCode(SEED, SIX, NOW) as string;

    const { view } = await raised(h, CODE_RAISE);
    await settled();

    should(h.writes).deepEqual([code]);
    should(JSON.stringify(view)).not.containEql(code);
    should(await h.everything()).not.containEql(code);
    // A code card is not a password: nothing to clear later.
    should(h.typeOptions[0]?.armClear).be.undefined();
  });
});

describe('a password left in a field is emptied before the hold ends, and the line stops', () => {
  it('should ask the browser about the typed nodes only, while the page is still held, shortly before the hold ends', async () => {
    const h = harness({ clear: 'moved' });
    await approve(h, await github(h), { remaining: 2 });
    await raised(h);
    const hold = h.timers.at(-1);
    // Two seconds before the write's 120-second hold ends.
    should(hold?.ms).equal(118_000);
    // Even when the timer fires late, after the write's own hold has run out, the clear holds the page itself.
    h.advance(125_000);
    hold?.fire();
    await settled();

    should(h.clears).deepEqual([{ navigationId: 'loader-1', fields: [{ frameId: 'main', backendNodeId: 12 }] }]);
    should(h.heldDuringClear).deepEqual([true]);
    should(JSON.stringify(h.clears)).not.containEql(PASSWORD);
    should(h.stopped).deepEqual([]);
    // Its own hold is let go once the clear answered.
    should(h.service.pageHeld(SESSION, ['app'])).be.undefined();
  });

  for (const outcome of ['cleared', 'unknown'] as const)
    it(`should stop the line when the browser answers ${outcome}`, async () => {
      const h = harness({ clear: outcome });
      await approve(h, await github(h), { remaining: 2 });
      await raised(h);
      h.timers.at(-1)?.fire();
      await settled();
      should(h.stopped).deepEqual(['0:did-not-move-on']);
    });
});

describe('a fill is held from the ferret like a tap, and pressed like one', () => {
  it('should hold the page after a plan fill', async () => {
    const h = harness();
    await approve(h, await github(h));
    await raised(h);
    should(h.service.pageHeld(SESSION, ['app'])).not.be.undefined();
  });

  it('should press Enter after the last value, unless the ferret raised the card to submit itself', async () => {
    const pressed = harness();
    await approve(pressed, await github(pressed));
    await raised(pressed);
    should(pressed.submits).deepEqual([true]);

    const own = harness();
    await approve(own, await github(own));
    await raised(own, { ...SIGN_IN, submit: 'agent' });
    should(own.submits).deepEqual([false]);
  });

  it('should tell the login observer the fill was the plan’s, not an owner’s tap', async () => {
    const h = harness();
    await approve(h, await github(h));
    await raised(h);
    await settled();
    should(h.delivered).deepEqual(['plan']);
  });

  it('should keep the password out of the ferret’s own view as well as every record', async () => {
    const h = harness();
    await approve(h, await github(h));
    const { view } = await raised(h);
    await settled();
    should(JSON.stringify(view)).not.containEql(PASSWORD);
    should(JSON.stringify(view)).not.containEql(USERNAME);
    should(await h.everything()).not.containEql(PASSWORD);
  });
});

describe('one use is one sign-in attempt, and each role is typed once per use', () => {
  const CODE_RAISE: InputRaise = {
    target: { kind: 'browser', key: 'app' },
    prompt: 'GitHub wants the 2FA code',
    fields: [{ id: 'otp', sensitivity: 'code', element: { kind: 'ref', ref: 'e3' } }],
    submit: 'owner-default',
  };
  const PASSWORD_ONLY: InputRaise = {
    target: { kind: 'browser', key: 'app' },
    prompt: 'GitHub wants your password again',
    fields: [{ id: 'pass', sensitivity: 'secret', element: { kind: 'ref', ref: 'e2' } }],
    submit: 'owner-default',
  };
  const SIX = { algorithm: 'SHA1', digits: 6, period: 30 } as const;

  it('should fill the password page and then the code page on one use', async () => {
    const h = harness();
    const signIn = await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED, 'Authenticator app');
    await approve(h, signIn, { fields: ['password', 'totp', 'username'] });
    await raised(h);

    h.setFacts(
      loginPage({ navigationId: 'loader-2' }, [field('otp', {}, { type: 'text', autocomplete: 'one-time-code' })]),
    );
    const { view } = await raised(h, CODE_RAISE);

    should(view.state).equal('delivered');
    should(h.writes).deepEqual([USERNAME, PASSWORD, totpCode(SEED, SIX, NOW) as string]);
    should(h.used).deepEqual([`${PLAN}:0`]);
    // The code step joined the open attempt, so its card was raised quiet too.
    should(h.quietAtRaise).deepEqual([true, true]);
  });

  it('should never type the password a second time on one use: a confirm-password form asks the owner', async () => {
    const h = harness();
    await approve(h, await github(h));
    await raised(h);

    h.setFacts(loginPage({ navigationId: 'loader-2' }, [field('pass', {}, { name: 'sudo_password' })]));
    const { view, request } = await raised(h, PASSWORD_ONLY);

    should(h.writes).deepEqual([USERNAME, PASSWORD]);
    should(view.state).equal('pending');
    should(request?.preapproval).match({ outcome: 'did-not-apply', reason: 'used-up' });
  });

  it('should spend a second use for a second password', async () => {
    const h = harness();
    await approve(h, await github(h), { remaining: 2 });
    await raised(h);

    h.setFacts(loginPage({ navigationId: 'loader-2' }, [field('pass')]));
    await raised(h, PASSWORD_ONLY);

    should(h.writes).deepEqual([USERNAME, PASSWORD, PASSWORD]);
    should(h.used).deepEqual([`${PLAN}:0`, `${PLAN}:0`]);
  });
});

describe('a revoke or an expiry during a fill stops the write', () => {
  it('should type nothing when the line is revoked between the raise and the write’s look', async () => {
    let h: Harness | undefined;
    h = harness({ onLook: look => look === 2 && h?.lines.splice(0) });
    await approve(h, await github(h));

    const { view, request } = await raised(h);

    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).match({ outcome: 'did-not-apply', reason: 'expired' });
    should(h.used).deepEqual([]);
  });

  it('should type nothing when the line is revoked just before the write, after every look', async () => {
    let h: Harness | undefined;
    h = harness({ onJournal: type => type.endsWith('delivering') && h?.lines.splice(0) });
    await approve(h, await github(h));

    const { view, request } = await raised(h);

    should(h.writes).deepEqual([]);
    should(h.typeOptions).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).match({ outcome: 'did-not-apply', reason: 'expired' });
    // Nothing was typed, so the page is not held and the use is given back.
    should(h.service.pageHeld(SESSION, ['app'])).be.undefined();
    should(h.used).deepEqual([]);
  });

  it('should hand a quiet card back to the owner at once when its line ends while it is raised', async () => {
    let h: Harness | undefined;
    h = harness({ onRaise: () => h?.lines.splice(0) });
    await approve(h, await github(h));

    const { view } = await raised(h);

    should(h.quietAtRaise).deepEqual([true]);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(h.sinks).containEql(`noted ${view.id}: A task plan line didn't apply here, so you're asked as usual.`);
  });
});

describe('a terminal line is for sudo, su or doas running setuid root', () => {
  const SUDO: InputRaise = {
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'sudo wants your password',
    sensitivity: 'secret',
    submit: 'owner-default',
  };

  async function sudoAccount(h: Harness): Promise<SignInId> {
    await h.directory.put(
      'KIRIN',
      PutLoginEntryRequestSchema.parse({ label: 'Kirin', password: PASSWORD, match: ['sudo@kirin-box'] }),
    );
    return await signInOf(h, 'KIRIN');
  }

  it('should type the password into a proved sudo prompt', async () => {
    const h = harness({ facts: sudoPrompt() });
    await approve(h, await sudoAccount(h));
    const { view } = await raised(h, SUDO);
    should(h.writes).deepEqual([PASSWORD]);
    should(view.state).equal('delivered');
    should(h.typeOptions[0]?.armClear).be.undefined();
  });

  it('should type nothing into a sudo that is not running setuid root', async () => {
    const h = harness({ facts: sudoPrompt({ trustedProgram: undefined }) });
    await approve(h, await sudoAccount(h));
    const { request } = await raised(h, SUDO);
    should(h.writes).deepEqual([]);
    should(request?.preapproval?.reason).equal('not-system');
  });

  it('should type nothing into a prompt echoing what is typed, or one not in line mode', async () => {
    for (const facts of [sudoPrompt({ echo: 'on' }), sudoPrompt({ recognisedConsumer: false })]) {
      const h = harness({ facts });
      await approve(h, await sudoAccount(h));
      const { request } = await raised(h, SUDO);
      should(h.writes).deepEqual([]);
      should(request?.preapproval?.reason).equal('not-proved');
    }
  });

  it('should treat a prompt not in line mode (a relay) as no match at all, and type nothing', async () => {
    const h = harness({ facts: sudoPrompt({ canonical: false }) });
    await approve(h, await sudoAccount(h));
    const { view, request } = await raised(h, SUDO);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).be.undefined();
  });

  it('should treat a shell that only calls itself sudo as no match at all', async () => {
    const h = harness({ facts: sudoPrompt({ program: undefined, trustedProgram: undefined }) });
    await approve(h, await sudoAccount(h));
    const { view, request } = await raised(h, SUDO);
    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).be.undefined();
  });
});

describe('the second match, at the write, holds or nothing is typed', () => {
  it('should type nothing when the ferret ran a page script between the raise and the write, and leave the owner’s card', async () => {
    // The raise's look passes every check; by the write's look the ferret has run a script in this session.
    const h = harness({ onLook: (look, at) => look === 2 && at.setScripted(true) });
    await approve(h, await github(h));

    const { view, request } = await raised(h);

    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).match({ outcome: 'did-not-apply', reason: 'scripted' });
    should(view.note).equal(`${TASK_PLAN_MISS_AGENT_NOTE} Waiting for the owner on ${view.id}.`);
    // Nothing was typed, so the use was given back.
    should(h.used).deepEqual([]);
    should(h.lines[0]?.state).equal('approved');
    should(h.sinks).containEql(`noted ${view.id}: A task plan line didn't apply here, so you're asked as usual.`);
  });
});

describe('the rate limit is the ledger’s, after the matcher', () => {
  it('should type nothing once the sign-in was filled ten times this hour, and say why to the owner only', async () => {
    const h = harness();
    const signIn = await github(h);
    await approve(h, signIn);
    // Ten fills of this very sign-in this hour, under other grants and sessions.
    for (let index = 0; index < 10; index++) {
      const earlier = h.grants.ledger.reserve(
        { id: `plan:${'cd'.repeat(16)}:${String(index)}`, signIn, remaining: 1 },
        `session-${String(index)}`,
        ['username', 'password'],
        'password+username',
        NOW - 60_000,
      );
      if (typeof earlier === 'string') throw new Error(earlier);
      h.grants.ledger.spent(earlier, 'x');
    }

    const { view, request } = await raised(h);

    should(h.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(request?.preapproval).match({ outcome: 'did-not-apply', reason: 'rate' });
    should(view.note).equal(`${TASK_PLAN_MISS_AGENT_NOTE} Waiting for the owner on ${view.id}.`);
    should(h.used).deepEqual([]);
  });
});
