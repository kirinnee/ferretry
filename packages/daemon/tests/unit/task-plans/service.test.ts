import { describe, it } from 'bun:test';
import {
  type AccountId,
  type AccountKey,
  type AccountSummary,
  canonicalTaskPlanApproval,
  CopyPlanSchema,
  type LoginObserved,
  type Place,
  type SignInId,
  type SignInSummary,
  TASK_PLAN_MAX_PROPOSALS_PER_HOUR,
  type TaskPlan,
  type TaskPlanApproval,
  taskPlanApprovalSubject,
  TaskPlanSchema,
  type TaskPlanStageId,
} from '@ferretry/protocol';
import should from 'should';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import {
  type PasteRuleCaller,
  PasteRuleService,
  SecureCopyError,
  TASK_PLAN_HONEST_LIMIT,
  type TaskPlanCard,
  TaskPlanError,
  TaskPlanProofMissing,
  TaskPlanService,
} from '../../../src/lib/index.ts';
import { FACTS } from '../input-requests/support.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const SESSION = 's1';
const HOST: PasteRuleCaller = { kind: 'owner', actor: { kind: 'host' } };
const PHONE: PasteRuleCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'phone-1' } };
const AGENT: PasteRuleCaller = { kind: 'agent' };
const PASSWORD = 'hunter2-UNIQUE-pw';

const KEYS: Readonly<Record<string, AccountKey>> = {
  GITHUB_WORK: `L${'A'.repeat(24)}`,
  GITHUB_HOME: `L${'B'.repeat(24)}`,
  KIRIN: `L${'C'.repeat(24)}`,
  CLICKUP: `L${'D'.repeat(24)}`,
};
const SI = {
  work: 'si_00000000000000a1',
  home: 'si_00000000000000a2',
  sudo: 'si_00000000000000c1',
  ssh: 'si_00000000000000c2',
  clickup: 'si_00000000000000d1',
} as const satisfies Record<string, SignInId>;

const account = (id: string, label: string, options: { username?: string; totp?: boolean } = {}): AccountSummary =>
  ({
    id: id as AccountId,
    label,
    ...(options.username === undefined ? {} : { username: options.username }),
    fields: { password: true, totp: options.totp === true },
    factors: [],
    signIns: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }) as AccountSummary;

const site = (domains: string[], match: string[] = []): Place => ({ kind: 'site', domains, match });
const sudoAt = (tool = 'sudo'): Place => ({ kind: 'terminal', tool, host: 'kirin-box' });

/** An identity the daemon saw masked, with the page moving on twice: history. */
const HISTORY: LoginObserved = {
  at: 'github.com',
  surface: 'page',
  identity: 'abcdef0123456789',
  since: '2026-10-01T00:00:00.000Z',
  masked: { value: true, observedAt: '2026-10-02T00:00:00.000Z', count: 2 },
  navigatedAway: { value: true, observedAt: '2026-10-02T00:00:00.000Z', count: 2 },
};

const signIn = (id: SignInId, owner: string, place: Place, extra: Partial<SignInSummary> = {}): SignInSummary =>
  ({
    id,
    account: owner as AccountId,
    place,
    method: { kind: 'password' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }) as SignInSummary;

function listing() {
  return {
    accounts: [
      account('GITHUB_WORK', 'GitHub work', { username: 'kirin-work', totp: true }),
      account('GITHUB_HOME', 'GitHub home', { username: 'kirinnee' }),
      account('KIRIN', 'kirin', { username: 'kirin' }),
      account('CLICKUP', 'ClickUp', { username: 'k@example.com' }),
    ],
    signIns: [
      signIn(SI.work, 'GITHUB_WORK', site(['github.com']), { recipeVersion: 3, observed: [HISTORY] }),
      signIn(SI.home, 'GITHUB_HOME', site(['github.com'])),
      signIn(SI.sudo, 'KIRIN', sudoAt()),
      signIn(SI.ssh, 'KIRIN', { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'build' }),
      signIn(SI.clickup, 'CLICKUP', site(['app.clickup.com']), {
        method: { kind: 'sso', name: 'Google' },
      } as Partial<SignInSummary>),
    ],
  };
}

const GH = { kind: 'command', program: 'gh' } as const;
const PASTE = {
  kind: 'paste',
  from: GH,
  to: { kind: 'terminal', program: 'vercel' },
  why: 'the deploy token',
} as const;
const PAGE_PASTE = {
  kind: 'paste',
  from: GH,
  to: { kind: 'browser', origin: 'https://vercel.com' },
  why: 'the token field',
} as const;
const WORK_LINE = {
  kind: 'sign-in',
  signIn: SI.work,
  fields: ['username', 'password', 'totp'],
  why: 'check Actions',
} as const;
const SITE_LINE = { kind: 'sign-in', site: 'github.com', fields: ['password'], why: 'open the repo' } as const;
const SUDO_LINE = { kind: 'terminal-sign-in', place: 'sudo@kirin-box', why: 'install a package' } as const;

function world() {
  const ms = { now: NOW };
  const writes: unknown[] = [];
  const rules = new PasteRuleService({
    store: { read: async () => undefined, write: async next => void writes.push(next) },
    clock: { now: () => ms.now },
    ids: {
      ruleId: (() => {
        let id = 0;
        return () => (++id).toString(16).padStart(32, '0');
      })(),
    },
    warn: () => undefined,
  });
  const cards: { sessionId: string; planId: string; pastes: boolean; ask: string; context: string; how: string }[] = [];
  const closed: string[] = [];
  const told: string[] = [];
  const audits: AuditEntry[] = [];
  const state = { listing: listing(), passkey: true, defaults: undefined as unknown };
  let plan = 0;
  let stage = 0;
  const ports = {
    agenda: {
      raise: async (sessionId: string, card: TaskPlanCard) => {
        cards.push({
          sessionId,
          planId: card.planId,
          pastes: card.pastes,
          ask: card.ask,
          context: card.context,
          how: card.howToResolve,
        });
        return { ok: true as const, id: `A${String(cards.length)}` };
      },
      close: async (_sessionId: string, id: string, note: string) => void closed.push(`${id}: ${note}`),
    },
    rules,
    accounts: {
      listing: async () => state.listing,
      keyOf: async (id: AccountId) => KEYS[id],
    },
    choice: { of: async () => ({ defaults: state.defaults as never }) },
    passkeys: { any: async () => state.passkey },
    redact: async (text: string) => text.replaceAll(PASSWORD, '[secret]'),
    tell: async (_sessionId: string, _agenda: string, message: string) => void told.push(message),
    audit: { record: async (entry: AuditEntry) => void audits.push(entry) },
    clock: { now: () => ms.now },
    ids: {
      planId: () => (++plan).toString(16).padStart(32, 'b'),
      stageId: (): TaskPlanStageId => `tps_${(++stage).toString(16).padStart(24, '0')}`,
    },
  };
  const service = new TaskPlanService(ports);
  return { service, rules, ms, writes, cards, closed, told, audits, state, ports };
}

const refused = async (work: Promise<unknown> | (() => unknown)): Promise<SecureCopyError | TaskPlanError> => {
  const error = await Promise.resolve()
    .then(() => (typeof work === 'function' ? work() : work))
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  should(error instanceof SecureCopyError || error instanceof TaskPlanError).be.true();
  return error as SecureCopyError | TaskPlanError;
};

/** The claim a paired device's fresh `approve-task-plan` proof bound to `subject` makes: true for that subject only. */
const proofFor = (subject: string | undefined) => (asked: string) => asked === subject;

async function staged(w: ReturnType<typeof world>, plan: TaskPlan, approval: TaskPlanApproval, caller = PHONE) {
  const answer = await w.service.stage(caller, SESSION, plan.id, approval);
  if (answer.outcome !== 'staged') throw new Error('expected a staged selection');
  return answer.staged;
}

describe('TaskPlanService: the ferret asks', () => {
  it('should resolve every line against the accounts and raise ONE card in the daemon’s words', async () => {
    const w = world();
    await w.rules.load();

    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, SITE_LINE, SUDO_LINE, PASTE] });

    should(TaskPlanSchema.safeParse(plan).success).be.true();
    should(plan).match({ state: 'pending', agendaItemId: 'A1', expiresAt: '2026-11-01T14:00:00.000Z' });
    should(plan.lines.map(line => [line.kind, line.state])).eql([
      ['sign-in', 'waiting'],
      ['sign-in', 'waiting'],
      ['terminal-sign-in', 'waiting'],
      ['paste', 'waiting'],
    ]);
    should(plan.lines[0]).match({
      candidates: [{ signIn: SI.work, account: { id: 'GITHUB_WORK' }, can: { totp: true }, history: true }],
      preselect: { signIn: SI.work, why: 'ferret' },
      flags: ['one-factor'],
    });
    should(plan.lines[1]).match({ candidates: [{ signIn: SI.work }, { signIn: SI.home }], flags: ['no-history'] });
    should(plan.lines[1]).not.have.property('preselect');
    should(plan.lines[2]).match({
      fields: ['password'],
      flags: ['root', 'no-history'],
      candidates: [{ signIn: SI.sudo }],
    });
    should(w.cards).have.length(1);
    should(w.cards[0]).match({ sessionId: SESSION, pastes: true });
    should(w.cards[0]?.context).containEql('The ferret says: check Actions');
    should(w.cards[0]?.context).containEql(TASK_PLAN_HONEST_LIMIT);
    should(w.cards[0]?.how).containEql('passkey');
  });

  it("should preselect only the owner's own default on a picker, never the ferret's hint", async () => {
    const w = world();
    await w.rules.load();
    w.state.defaults = { sites: { 'github.com': 'GITHUB_HOME' } };

    const plan = await w.service.propose(SESSION, { lines: [SITE_LINE] });

    should(plan.lines[0]).match({ preselect: { signIn: SI.home, why: 'site' } });
  });

  it('should mask a reason that holds a secret before it is kept, shown or audited', async () => {
    const w = world();
    await w.rules.load();

    const plan = await w.service.propose(SESSION, { lines: [{ ...PASTE, why: `use ${PASSWORD} here` }] });

    should(plan.lines[0]?.why).equal('use [secret] here');
    should(JSON.stringify([w.cards, w.audits, plan])).not.containEql(PASSWORD);
  });

  it('should mark a line unavailable when it is not in Accounts, a provider sign-in or a terminal tool other than sudo', async () => {
    const w = world();
    await w.rules.load();

    const plan = await w.service.propose(SESSION, {
      lines: [
        { kind: 'sign-in', site: 'gitlab.com', fields: ['password'], why: 'mirror' },
        { kind: 'sign-in', site: 'app.clickup.com', fields: ['password'], why: 'tasks' },
        { kind: 'terminal-sign-in', place: 'ssh@build', why: 'deploy' },
      ],
    });

    should(plan.lines.map(line => (line.kind === 'paste' ? undefined : [line.state, line.because]))).eql([
      ['unavailable', 'not-in-accounts'],
      ['unavailable', 'via-provider'],
      ['unavailable', 'tool-not-covered'],
    ]);
    should(
      (await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 2, signIn: SI.ssh }] }))).message,
    ).match(/can't be ticked/u);
  });

  it('should refuse, raising no card: a field the schema refuses, two lines for one sign-in, a sign-in of the other kind', async () => {
    const w = world();
    await w.rules.load();

    const refusals = [
      await refused(w.service.propose(SESSION, { lines: [{ ...PASTE, origin: 'https://evil.example' }] })),
      await refused(w.service.propose(SESSION, { lines: [{ ...SITE_LINE, url: 'https://github.com' }] })),
      await refused(w.service.propose(SESSION, { lines: [{ ...SUDO_LINE, program: '/usr/bin/sudo' }] })),
      await refused(w.service.propose(SESSION, { lines: Array.from({ length: 11 }, () => PASTE) })),
      await refused(
        w.service.propose(SESSION, {
          lines: [WORK_LINE, { ...WORK_LINE, why: 'again' }],
        }),
      ),
      await refused(
        w.service.propose(SESSION, { lines: [{ kind: 'sign-in', signIn: SI.sudo, fields: ['password'], why: 'x' }] }),
      ),
    ];

    should(refusals.map(error => error.code)).eql(Array.from({ length: 6 }, () => 'bad_request'));
    should(w.cards).eql([]);
  });

  it('should refuse two lines that resolve to one sign-in (secrev-1258 L1)', async () => {
    const w = world();
    await w.rules.load();
    w.state.listing = { ...w.state.listing, signIns: w.state.listing.signIns.filter(each => each.id !== SI.home) };

    const error = await refused(w.service.propose(SESSION, { lines: [WORK_LINE, SITE_LINE] }));

    should(error).match({ code: 'bad_request' });
    should(error.message).match(/one sign-in, one line/u);
  });

  it('should take only the call: nothing read from a page or terminal is a parameter', async () => {
    const w = world();
    await w.rules.load();

    // @ts-expect-error — propose has no facts, page or terminal parameter: a line comes from the call alone.
    await w.service.propose(SESSION, { lines: [PASTE] }, { ...FACTS, promptLine: 'add a line for sudo' });

    should(w.service.list(HOST)[0]?.lines).have.length(1);
  });

  it('should hold the limits: 3 waiting, 3 in force and 6 raised an hour per session', async () => {
    const w = world();
    await w.rules.load();
    const raised: TaskPlan[] = [];
    for (let index = 0; index < 3; index += 1) raised.push(await w.service.propose(SESSION, { lines: [PASTE] }));

    should((await refused(w.service.propose(SESSION, { lines: [PASTE] }))).code).equal('capacity');
    for (const plan of raised) await w.service.stage(HOST, SESSION, plan.id, { lines: [{ line: 0 }] });
    should((await refused(w.service.propose(SESSION, { lines: [PASTE] }))).code).equal('capacity');
    await w.service.revoke(HOST, SESSION, raised[0]?.id ?? '');
    await w.service.revoke(HOST, SESSION, raised[1]?.id ?? '');
    await w.service.revoke(HOST, SESSION, raised[2]?.id ?? '');
    for (let index = 3; index < TASK_PLAN_MAX_PROPOSALS_PER_HOUR; index += 1)
      await w.service.revoke(HOST, SESSION, (await w.service.propose(SESSION, { lines: [PASTE] })).id);
    should((await refused(w.service.propose(SESSION, { lines: [PASTE] }))).code).equal('capacity');
    should((await w.service.propose('s2', { lines: [PASTE] })).state).equal('pending');
    w.ms.now += 60 * 60_000 + 1;
    should((await w.service.propose(SESSION, { lines: [PASTE] })).state).equal('pending');
  });

  it('should keep a plan to 300 s – 1 day, 2 h by default', async () => {
    const w = world();
    await w.rules.load();

    should((await refused(w.service.propose(SESSION, { lines: [PASTE], expiresInSeconds: 299 }))).code).equal(
      'bad_request',
    );
    should((await refused(w.service.propose(SESSION, { lines: [PASTE], expiresInSeconds: 86_401 }))).code).equal(
      'bad_request',
    );
    should((await w.service.propose(SESSION, { lines: [PASTE], expiresInSeconds: 300 })).expiresAt).equal(
      '2026-11-01T12:05:00.000Z',
    );
  });
});

describe('TaskPlanService: only the owner answers', () => {
  it('should refuse an agent caller on every owner method, before anything else', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, PASTE] });
    const stage = await staged(w, plan, { lines: [{ line: 0 }] });

    const codes = [
      (await refused(() => w.service.list(AGENT))).code,
      (await refused(() => w.service.get(AGENT, SESSION, plan.id))).code,
      (await refused(() => w.service.copyPlans(AGENT))).code,
      (await refused(w.service.stage(AGENT, SESSION, plan.id, { lines: [{ line: 1 }] }))).code,
      (await refused(w.service.commit(AGENT, SESSION, plan.id, stage.stage, () => true))).code,
      (await refused(() => w.service.viewStage(AGENT, SESSION, plan.id, stage.stage))).code,
      (await refused(() => w.service.confirmInApp(AGENT, SESSION, plan.id, stage.stage))).code,
      (await refused(() => w.service.drop(AGENT, SESSION, plan.id, stage.stage))).code,
      (await refused(w.service.approveCopyItems(AGENT, SESSION, plan.id, [0]))).code,
      (await refused(w.service.revoke(AGENT, SESSION, plan.id))).code,
    ];

    should(codes).eql(Array.from({ length: codes.length }, () => 'forbidden'));
    should(w.service.get(HOST, SESSION, plan.id).state).equal('pending');
  });
});

describe('TaskPlanService: approving', () => {
  it('should approve paste lines at once with no passkey, as a paste plan was, and write nothing', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [{ ...PASTE, uses: 3 }, PAGE_PASTE] });

    const answer = await w.service.stage(HOST, SESSION, plan.id, { lines: [{ line: 0 }] });

    should(answer).match({
      outcome: 'answered',
      plan: { state: 'approved', answered: { by: { kind: 'host' }, proof: 'none' } },
    });
    should(answer.outcome === 'answered' ? answer.plan.lines.map(line => line.state) : []).eql([
      'approved',
      'declined',
    ]);
    should(w.rules.list(HOST)).match([{ sessionId: SESSION, remaining: 3, plan: plan.id }]);
    should(w.writes).eql([]);
    should(w.closed).eql([`A1: You allowed line 1 until 2026-11-01 14:00 UTC.`]);
    should(w.told[0]).containEql('allowed line 1');
  });

  it('should decline a plan answered with nothing ticked', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE] });

    const answer = await w.service.stage(PHONE, SESSION, plan.id, { lines: [] });

    should(answer).match({ outcome: 'answered', plan: { state: 'declined' } });
    should(w.told[0]).containEql('declined');
  });

  it('should stage a ticked sign-in, bind its proof to the stage, and commit only with that proof', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, SUDO_LINE, PASTE] });
    const approval = { lines: [{ line: 0, totp: true }, { line: 2 }] };

    const stage = await staged(w, plan, approval);
    const bound = w.service.boundSubjectOf(stage.stage);
    const pins = new Map([
      [
        0,
        {
          accountKey: KEYS.GITHUB_WORK as AccountKey,
          placeKeys: ['github.com'],
          recipeVersion: 3,
          identities: [HISTORY.identity],
        },
      ],
    ]);
    const canonical = canonicalTaskPlanApproval(plan, approval, pins);

    should(stage).match({ plan: plan.id, lines: [0, 2], expiresAt: '2026-11-01T12:02:00.000Z' });
    should(stage.summary[0]).equal(
      'Line 1: sign in as GitHub work · kirin-work on github.com with its password, codes and username, 1 use',
    );
    should(canonical.ok && bound === taskPlanApprovalSubject(stage.stage, canonical.text)).be.true();
    should(
      await w.service.commit(PHONE, SESSION, plan.id, stage.stage, () => false).catch(error => error),
    ).be.instanceOf(TaskPlanProofMissing);
    should(w.service.get(HOST, SESSION, plan.id).state).equal('pending');

    const settled = await w.service.commit(PHONE, SESSION, plan.id, stage.stage, proofFor(bound));

    should(settled).match({
      state: 'approved',
      answered: { by: { kind: 'device', deviceId: 'phone-1' }, proof: 'passkey' },
    });
    should(settled.lines.map(line => line.state)).eql(['approved', 'declined', 'approved']);
    should(settled.lines[0]).match({ approved: { signIn: SI.work, totp: true, remaining: 1 } });
    should(w.service.approvedSignIns(SESSION)).match([
      { line: 0, signIn: SI.work, fields: ['password', 'totp', 'username'], pins: pins.get(0) },
    ]);
    should(w.rules.list(HOST)).have.length(1);
    should(w.service.viewStage(PHONE, SESSION, plan.id, stage.stage).state).equal('approved');
    should(w.service.boundSubjectOf(stage.stage)).be.undefined();
  });

  it('should take no other proof: none, another stage’s, or a second use of the same', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE] });
    const first = await staged(w, plan, { lines: [{ line: 0 }] });
    const firstBound = w.service.boundSubjectOf(first.stage);
    const second = await staged(w, plan, { lines: [{ line: 0, totp: true }] });

    const missing = await w.service.commit(PHONE, SESSION, plan.id, second.stage, () => false).catch(error => error);
    const borrowed = await w.service
      .commit(PHONE, SESSION, plan.id, second.stage, proofFor(firstBound))
      .catch(error => error);
    const dropped = await refused(w.service.commit(PHONE, SESSION, plan.id, first.stage, proofFor(firstBound)));

    should(missing).be.instanceOf(TaskPlanProofMissing);
    should(borrowed).be.instanceOf(TaskPlanProofMissing);
    should(dropped).match({ status: 404, code: 'stage_not_found' });
    await w.service.commit(PHONE, SESSION, plan.id, second.stage, proofFor(w.service.boundSubjectOf(second.stage)));
    should((await refused(w.service.commit(PHONE, SESSION, plan.id, second.stage, () => true))).code).equal(
      'stage_not_found',
    );
  });

  it('should never record a passkey approval the machine made: the record refuses it, and nothing is made', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, PASTE] });
    const stage = await staged(w, plan, { lines: [{ line: 0 }, { line: 1 }] }, HOST);

    // Even a claim that (impossibly) succeeds for the machine's token records nothing: a passkey lives on a device.
    const error = await refused(w.service.commit(HOST, SESSION, plan.id, stage.stage, () => true));

    should(error.code).equal('conflict');
    should(w.service.get(HOST, SESSION, plan.id).state).equal('pending');
    should(w.rules.list(HOST)).eql([]);
    should(w.service.approvedSignIns(SESSION)).eql([]);
  });

  it("should take only one of the line's own candidates, and a code tick only where asked and possible", async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, {
      lines: [SITE_LINE, { kind: 'sign-in', signIn: SI.home, fields: ['password', 'totp'], why: 'home' }],
    });

    const errors = [
      await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 0 }] })),
      await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 0, signIn: SI.sudo }] })),
      await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 0, signIn: SI.work, totp: true }] })),
      await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 1, totp: true }] })),
      await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 5 }] })),
    ];

    should(errors.map(error => error.code)).eql(Array.from({ length: 5 }, () => 'bad_request'));
    should(errors.map(error => error.message)).match([
      /pick one of the accounts first/u,
      /accounts the card lists/u,
      /did not ask for codes/u,
      /no automatic codes/u,
      /no such line/u,
    ]);
  });

  it('should ask for a passkey to be added first when no device holds one; paste lines still pass', async () => {
    const w = world();
    await w.rules.load();
    w.state.passkey = false;
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, PASTE] });

    const error = await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 0 }] }));
    const answer = await w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 1 }] });

    should(error).match({ status: 409, code: 'passkey_required' });
    should(answer).match({ outcome: 'answered', plan: { state: 'approved' } });
  });

  it('should refuse to stage a sign-in that changed since the card was drawn', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, SUDO_LINE] });
    w.state.listing = {
      ...w.state.listing,
      signIns: w.state.listing.signIns
        .filter(each => each.id !== SI.sudo)
        .map(each => (each.id === SI.work ? { ...each, place: site(['github.com', 'gh.evil.example']) } : each)),
    };

    const moved = await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 0 }] }));
    const gone = await refused(w.service.stage(PHONE, SESSION, plan.id, { lines: [{ line: 1 }] }));

    should([moved.code, gone.code]).eql(['conflict', 'conflict']);
    should(moved.message).match(/login domains changed/u);
    should(gone.message).match(/removed or moved/u);
  });

  it('should be all or nothing: a paste rule that cannot be made leaves the plan pending and grants nothing', async () => {
    const w = world();
    const failing = new TaskPlanService({
      ...w.ports,
      rules: {
        fromPlan: () => {
          throw new SecureCopyError('capacity', 'full');
        },
        endPlan: () => undefined,
        planUses: () => new Map(),
      },
    });
    const plan = await failing.propose(SESSION, { lines: [WORK_LINE, PASTE] });
    const answer = await failing.stage(PHONE, SESSION, plan.id, { lines: [{ line: 0 }, { line: 1 }] });
    const stage = answer.outcome === 'staged' ? answer.staged.stage : ('tps_' as TaskPlanStageId);

    const error = await refused(
      failing.commit(PHONE, SESSION, plan.id, stage, proofFor(failing.boundSubjectOf(stage))),
    );

    should(error.code).equal('capacity');
    should(failing.get(HOST, SESSION, plan.id).state).equal('pending');
    should(failing.approvedSignIns(SESSION)).eql([]);
  });

  it('should commit once when two commits race', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE] });
    const stage = await staged(w, plan, { lines: [{ line: 0 }] });
    const proof = proofFor(w.service.boundSubjectOf(stage.stage));

    const [first, second] = await Promise.allSettled([
      w.service.commit(PHONE, SESSION, plan.id, stage.stage, proof),
      w.service.commit(PHONE, SESSION, plan.id, stage.stage, proof),
    ]);

    should(first.status).equal('fulfilled');
    should(second.status).equal('rejected');
    should(w.audits.filter(entry => entry.detail?.action === 'task-plan-answered')).have.length(1);
  });

  it('should show a selection staged at the machine on the plan’s own card, for the phone to confirm', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE] });
    const stage = await staged(w, plan, { lines: [{ line: 0 }] }, HOST);

    const confirming = w.service.confirmInApp(HOST, SESSION, plan.id, stage.stage);

    should(confirming).eql({ stage: stage.stage, plan: plan.id, agendaItemId: 'A1' });
    should(w.service.get(PHONE, SESSION, plan.id).machineStage).match({ stage: stage.stage, lines: [0] });
    should(w.cards).have.length(1);
    await w.service.commit(PHONE, SESSION, plan.id, stage.stage, proofFor(w.service.boundSubjectOf(stage.stage)));
    should(w.service.get(HOST, SESSION, plan.id)).match({ state: 'approved' });
    should(w.service.get(HOST, SESSION, plan.id)).not.have.property('machineStage');
  });

  it("should let the machine read or drop only its own stage, and a dropped stage clear the card's", async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE] });
    const fromPhone = await staged(w, plan, { lines: [{ line: 0 }] });

    should((await refused(() => w.service.viewStage(HOST, SESSION, plan.id, fromPhone.stage))).code).equal(
      'stage_not_found',
    );
    const fromHost = await staged(w, plan, { lines: [{ line: 0 }] }, HOST);
    w.service.confirmInApp(HOST, SESSION, plan.id, fromHost.stage);
    w.service.drop(PHONE, SESSION, plan.id, fromHost.stage);

    should(w.service.get(HOST, SESSION, plan.id)).not.have.property('machineStage');
    should(w.service.viewStage(HOST, SESSION, plan.id, fromHost.stage).state).equal('denied');
    should(w.service.boundSubjectOf(fromHost.stage)).be.undefined();
  });

  it('should keep a plan to its own session: another session reads it as not found and gets no grant', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE] });
    const stage = await staged(w, plan, { lines: [{ line: 0 }] });

    should((await refused(() => w.service.get(HOST, 's2', plan.id))).code).equal('not_found');
    should((await refused(w.service.commit(PHONE, 's2', plan.id, stage.stage, () => true))).code).equal(
      'stage_not_found',
    );
    await w.service.commit(PHONE, SESSION, plan.id, stage.stage, proofFor(w.service.boundSubjectOf(stage.stage)));
    should(w.service.approvedSignIns('s2')).eql([]);
    should(w.service.approvedSignIns(`${SESSION}-child`)).eql([]);
  });
});

describe('TaskPlanService: life, revoke and the session ending', () => {
  async function approved(w: ReturnType<typeof world>) {
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, PASTE] });
    const stage = await staged(w, plan, { lines: [{ line: 0 }, { line: 1 }] });
    return await w.service.commit(
      PHONE,
      SESSION,
      plan.id,
      stage.stage,
      proofFor(w.service.boundSubjectOf(stage.stage)),
    );
  }

  it('should revoke one line or the whole plan with no passkey, at once', async () => {
    const w = world();
    const plan = await approved(w);

    const narrowed = await w.service.revoke(HOST, SESSION, plan.id, [1]);

    should(narrowed.lines.map(line => line.state)).eql(['approved', 'ended']);
    should(w.rules.list(HOST)).eql([]);
    should(w.service.approvedSignIns(SESSION)).have.length(1);
    should((await w.service.revoke(PHONE, SESSION, plan.id)).state).equal('revoked');
    should(w.service.approvedSignIns(SESSION)).eql([]);
    should(w.audits.filter(entry => entry.detail?.action === 'task-plan-ended').map(entry => entry.detail?.cause)).eql([
      'revoked',
      'revoked',
    ]);
    should((await refused(w.service.revoke(HOST, SESSION, plan.id))).code).equal('conflict');
  });

  it('should end every plan of a session that ended: the card closed, its pastes and grants gone', async () => {
    const w = world();
    const live = await approved(w);
    const waiting = await w.service.propose(SESSION, { lines: [PASTE] });

    await w.service.sessionEnded(SESSION);

    should(w.service.get(HOST, SESSION, live.id).state).equal('ended');
    should(w.service.get(HOST, SESSION, waiting.id).state).equal('ended');
    should(w.closed).containEql('A2: The task plan ended with its session.');
    should(w.rules.list(HOST)).eql([]);
    should(w.service.approvedSignIns(SESSION)).eql([]);
  });

  it('should expire a waiting plan, end an approved one, and let go of a stage after two minutes', async () => {
    const w = world();
    const live = await approved(w);
    const waiting = await w.service.propose(SESSION, { lines: [WORK_LINE], expiresInSeconds: 300 });
    const stage = await staged(w, waiting, { lines: [{ line: 0 }] });

    w.ms.now += 120_000;
    should(w.service.boundSubjectOf(stage.stage)).be.undefined();
    w.ms.now += 180_000;
    w.service.sweep();
    should(w.service.get(HOST, SESSION, waiting.id).state).equal('expired');
    should(w.closed).containEql('A2: The task plan expired.');
    should(w.service.get(HOST, SESSION, live.id).state).equal('approved');
    w.ms.now += 7_200_000;
    w.service.sweep();

    should(w.service.get(HOST, SESSION, live.id).state).equal('ended');
    should(w.rules.list(HOST)).eql([]);
    should(w.service.approvedSignIns(SESSION)).eql([]);
    w.ms.now += 11 * 60_000;
    should(w.service.list(HOST)).eql([]);
  });

  it('should hold nothing anywhere but memory: a new service (a restart) has no plan, no paste and no grant', async () => {
    const w = world();
    const plan = await approved(w);
    await w.service.revoke(HOST, SESSION, plan.id, [1]);
    const restarted = new TaskPlanService({
      ...w.ports,
      rules: new PasteRuleService({
        store: { read: async () => undefined, write: async () => undefined },
        clock: { now: () => w.ms.now },
        ids: { ruleId: () => '0'.repeat(32) },
        warn: () => undefined,
      }),
    });

    should(w.writes).eql([]);
    should(restarted.list(HOST)).eql([]);
    should(restarted.approvedSignIns(SESSION)).eql([]);
    should((await refused(() => restarted.get(HOST, SESSION, plan.id))).code).equal('not_found');
  });
});

describe('TaskPlanService: the paste-plan routes, kept', () => {
  it('should project a plan as a paste plan of its paste lines only', async () => {
    const w = world();
    await w.rules.load();
    const mixed = await w.service.propose(SESSION, { lines: [WORK_LINE, PASTE] });
    await w.service.propose(SESSION, { lines: [WORK_LINE] });

    const projected = w.service.copyPlans(HOST);

    should(projected.map(plan => plan.id)).eql([mixed.id]);
    should(CopyPlanSchema.parse(projected[0])).match({ items: [{ to: { program: 'vercel' } }] });
  });

  it('should read an old item number as its paste line, never as a line number: item 0 is not sign-in line 0', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, PASTE] });

    should((await refused(w.service.approveCopyItems(HOST, SESSION, plan.id, [1]))).code).equal('bad_request');
    const settled = await w.service.approveCopyItems(HOST, SESSION, plan.id, [0]);

    should(CopyPlanSchema.parse(settled)).match({ state: 'approved', approved: [0] });
    should(w.service.get(HOST, SESSION, plan.id).lines.map(line => line.state)).eql(['declined', 'approved']);
    should(w.service.approvedSignIns(SESSION)).eql([]);
  });

  it('should answer secure.preapprove through the same propose, in the old shape', async () => {
    const w = world();
    await w.rules.load();

    const plan = await w.service.proposePastes(SESSION, [{ from: GH, to: PASTE.to, why: 'the token' }], 600);

    should(CopyPlanSchema.parse(plan)).match({ state: 'pending', items: [{ why: 'the token' }] });
    should(w.service.get(HOST, SESSION, plan.id).lines).match([{ kind: 'paste', uses: 1 }]);
    should((await refused(w.service.approveCopyItems(HOST, SESSION, 'c'.repeat(32), [0]))).code).equal('not_found');
  });
});

describe('TaskPlanService: the audit', () => {
  it('should keep what was asked and allowed, line by line, and never a value', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.service.propose(SESSION, { lines: [WORK_LINE, SUDO_LINE] });
    const stage = await staged(w, plan, { lines: [{ line: 0 }] });
    await w.service.commit(PHONE, SESSION, plan.id, stage.stage, proofFor(w.service.boundSubjectOf(stage.stage)));

    const actions = w.audits.map(entry => [entry.event, entry.subject, entry.detail?.action]);

    should(actions).eql([
      ['security.changed', plan.id, 'task-plan-raised'],
      ['security.changed', plan.id, 'task-plan-raised'],
      ['security.changed', plan.id, 'task-plan-answered'],
      ['security.changed', plan.id, 'task-plan-line-approved'],
    ]);
    should(w.audits[2]).match({
      actor: { kind: 'device', deviceId: 'phone-1' },
      detail: { proof: 'passkey', approved: '1', declined: '2', expiresAt: plan.expiresAt },
    });
    should(w.audits[3]?.detail).match({
      signIn: SI.work,
      account: 'GITHUB_WORK',
      fields: 'password+username',
      why: 'check Actions',
    });
    should(JSON.stringify(w.audits)).not.match(/kirin-work|hunter2/u);
  });
});
