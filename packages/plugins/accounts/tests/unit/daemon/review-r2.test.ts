import { expect, it } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { type AuditDraft, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { StateFileDef } from '@ferretry/kernel/contract';
import { device, ferret, fixedClock, testHost, type TestHost } from '@ferretry/kernel/testing';
import accounts from '../../../daemon/index.ts';
import {
  type AccountIndexDocument,
  addTwoFactorKeySubject,
  padInputValue,
  type SignInRuleView,
  type SignInSummary,
  type StoredStepUpProof,
} from '../../../contract/routes/index.ts';
import { approved, DEVICE, tappedFact, world, type FakeProofs } from './sign-in-rules/support.ts';

const PASSWORD = 'synthetic-accounts-r2-password';
const security = {
  devices: async () => [{ id: DEVICE }],
  holdsPasskey: async (device: string) => device === DEVICE,
};
const stateDef = (name: string): StateFileDef => accounts.manifest.data.state.find(file => file.name === name)!;

/** The composed Accounts daemon over the contract fakes, with the stored-proof registry a rule world answers. */
async function host(
  options: { proofs?: () => FakeProofs | undefined; audits?: AuditDraft[]; gate?: StandInAdmission } = {},
) {
  const audits = options.audits ?? [];
  return await testHost({
    plugins: [accounts],
    gate: options.gate ?? new StandInAdmission(() => ownerStanding()),
    clock: fixedClock('2026-11-01T12:00:00.000Z'),
    uses: {
      access: {
        ...security,
        holds: async (device: string, credential: string) =>
          (await options.proofs?.()?.holds(device, credential)) ?? false,
        verifyStoredProof: async (proof: StoredStepUpProof, challenge: Uint8Array) =>
          (await options.proofs?.()?.verify(proof, challenge)) ?? false,
      },
    },
    fakes: {
      vault: new FakeVault(),
      sealed: new FakeSealedDocuments(),
      asks: new FakeAsks(),
      gate: { audit: async (entry: AuditDraft) => void audits.push(entry) },
    },
  });
}

async function savedSignIn(h: TestHost): Promise<SignInSummary> {
  const put = await h.request('PUT', '/v1/accounts/REVIEW', {
    body: { label: 'Review', username: 'fixture', password: PASSWORD },
  });
  expect(put.status).toBe(200);
  const added = await h.request('POST', '/v1/accounts/REVIEW/sign-ins', {
    body: { place: { kind: 'site', domains: ['example.com'], match: ['example.com'] } },
  });
  expect(added.status).toBe(200);
  return added.json<SignInSummary>();
}

/** Plants an approved standing rule for the account's sign-in in the daemon's rules file, then loads it. */
async function plantRule(h: TestHost, added: SignInSummary, registry: { proofs?: FakeProofs }) {
  const index = JSON.parse(h.state('accounts').raw(stateDef('accounts')) ?? '{}') as AccountIndexDocument;
  h.state('accounts').plant(
    stateDef('accounts'),
    JSON.stringify({
      ...index,
      signIns: { ...index.signIns, [added.id]: { ...index.signIns[added.id]!, observed: [tappedFact('example.com')] } },
    }),
  );
  const listing = (await h.request('GET', '/v1/accounts')).json<{ accounts: never[]; signIns: SignInSummary[] }>();
  const w = await world({ listing: { ...listing, keys: new Map([['REVIEW', index.accounts.REVIEW!.key]]) } });
  registry.proofs = w.proofs;
  await approved(w, { signIn: added.id, fields: ['username', 'password'] });
  if (w.store.document === undefined) throw new Error('fixture missing');
  h.state('accounts').plant(stateDef('sign-in-rules'), JSON.stringify({ format: 1, ...w.store.document }));
  await h.runJob('accounts.sign-in-rules');
  return w;
}

it('S123 an orderly stop writes the suspension a failed write left in memory, so a restart keeps the rule suspended', async () => {
  const registry: { proofs?: FakeProofs } = {};
  const h = await host({ proofs: () => registry.proofs });
  let restarted: TestHost | undefined;
  try {
    const added = await savedSignIn(h);
    await plantRule(h, added, registry);
    const rulesPath = stateDef('sign-in-rules').path;
    expect(
      (await h.request('GET', '/v1/sign-in-rules')).json<{ rules: SignInRuleView[] }>().rules[0]?.suspended,
    ).toBeUndefined();

    // The rules file cannot be written; the pinned username changes and changes back.
    const files = h.state('accounts').files;
    const set = files.set.bind(files);
    let failing = true;
    files.set = (key: string, value: string) => {
      if (failing && key === rulesPath) throw new Error('disk full');
      return set(key, value);
    };
    const rename = async (username: string) =>
      await h.request('PUT', '/v1/accounts/REVIEW', { body: { label: 'Review', username, password: PASSWORD } });
    expect((await rename('someone-else')).status).toBe(200);
    expect((await rename('fixture')).status).toBe(200);
    await h.settle();
    const live = (await h.request('GET', '/v1/sign-in-rules')).json<{ rules: SignInRuleView[] }>().rules[0];
    expect(live?.suspended).toBeDefined();
    expect(
      JSON.parse(h.state('accounts').raw(stateDef('sign-in-rules')) ?? '{}').rules?.[0]?.suspended,
    ).toBeUndefined();

    // Storage is writable again and the daemon stops in order before the next sweep.
    failing = false;
    await h.stop();
    expect(JSON.stringify(JSON.parse(h.state('accounts').raw(stateDef('sign-in-rules')) ?? '{}'))).toContain(
      'suspended',
    );

    restarted = await h.restart();
    await restarted.runJob('accounts.sign-in-rules');
    const after = (await restarted.request('GET', '/v1/sign-in-rules')).json<{ rules: SignInRuleView[] }>().rules[0];
    expect(after?.suspended).toBeDefined();
  } finally {
    await restarted?.stop();
    await h.stop();
  }
});

// ─── finding 2: the owner-session fallback and the code-card connection ─────────────────────────────────────────

const SEED = 'JBSWY3DPEHPK3PXP';
const REQUEST = 'a'.repeat(32);

interface Placed {
  readonly ferrets?: unknown;
  readonly board?: unknown;
  readonly projects?: unknown;
  readonly vault?: FakeVault;
  readonly config?: Record<string, unknown>;
}

async function placedHost(placed: Placed, gate?: StandInAdmission) {
  return await testHost({
    plugins: [accounts],
    ...(gate === undefined ? {} : { gate }),
    clock: fixedClock('2026-11-01T12:00:00.000Z'),
    ...(placed.config === undefined ? {} : { config: placed.config }),
    uses: {
      access: security,
      ...(placed.ferrets === undefined ? {} : { ferrets: placed.ferrets }),
      ...(placed.board === undefined ? {} : { board: placed.board }),
      ...(placed.projects === undefined ? {} : { projects: placed.projects }),
    },
    fakes: {
      vault: placed.vault ?? new FakeVault(),
      sealed: new FakeSealedDocuments(),
      asks: new FakeAsks(),
      gate: { audit: async (_entry: AuditDraft) => undefined },
    },
  });
}

const liveFerrets = {
  list: async () => [
    { id: 'F1', state: 'working', stateAt: '2026-11-01T10:00:00.000Z' },
    { id: 'F2', state: 'idle', stateAt: '2026-11-01T11:00:00.000Z' },
    { id: 'F3', state: 'stopped', stateAt: '2026-11-01T11:30:00.000Z' },
  ],
  get: async () => undefined,
  workFolder: async () => undefined,
};

it('I173 confirm-in-app with no session names the most recently active live ferret, through Ferrets', async () => {
  const h = await placedHost({ ferrets: liveFerrets });
  try {
    await savedSignIn(h);
    const staged = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
      body: { padded: padInputValue(SEED), totpAcknowledged: true },
    });
    expect(staged.status).toBe(201);
    const stage = staged.json<{ stage: string }>().stage;
    const confirm = await h.request('POST', `/v1/accounts/REVIEW/factors/seed/${stage}/confirm-in-app`, { body: {} });
    expect(confirm.status).toBe(201);
    expect(confirm.json<{ session: string }>().session).toBe('F2');
  } finally {
    await h.stop();
  }
});

it('I173 confirm-in-app with no session and no live ferret is refused 409 no_session', async () => {
  const h = await placedHost({ ferrets: { ...liveFerrets, list: async () => [] } });
  try {
    await savedSignIn(h);
    const staged = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
      body: { padded: padInputValue(SEED), totpAcknowledged: true },
    });
    const stage = staged.json<{ stage: string }>().stage;
    const confirm = await h.request('POST', `/v1/accounts/REVIEW/factors/seed/${stage}/confirm-in-app`, { body: {} });
    expect(confirm.status).toBe(409);
    expect(confirm.body).toContain('no_session');
  } finally {
    await h.stop();
  }
});

it('I173 a seed staged from the card the daemon matched is typed into that card once it is saved with a passkey', async () => {
  const typed: { request: string; account: string; observedDigest: string }[] = [];
  const cards = new Map([[REQUEST, { matchKey: 'example.com', observedDigest: 'digest-as-the-owner-saw-it' }]]);
  const vault = Object.assign(new FakeVault(), {
    cardTarget: (request: string) => cards.get(request),
    useNow: async (request: string, use: { account: string; observedDigest: string }) => {
      typed.push({ request, account: use.account, observedDigest: use.observedDigest });
      return true;
    },
  });
  let allowed: string | undefined;
  const gate = new StandInAdmission(() => ({
    ...deviceStanding(DEVICE),
    claimFreshStepUp: ((act: string, subject?: string) => act === 'add-2fa-key' && subject === allowed) as ReturnType<
      typeof ownerStanding
    >['claimFreshStepUp'],
  }));
  const h = await placedHost({ vault }, gate);
  const paired = { as: device(DEVICE) };
  try {
    await savedSignIn(h);
    const body = { padded: padInputValue(SEED), totpAcknowledged: true };
    // A card nobody matched to this account is refused, as is one that is not open.
    expect(
      (
        await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
          body: { ...body, request: 'b'.repeat(32) },
          ...paired,
        })
      ).status,
    ).toBe(409);
    cards.set('c'.repeat(32), { matchKey: 'elsewhere.test', observedDigest: 'other' });
    expect(
      (
        await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
          body: { ...body, request: 'c'.repeat(32) },
          ...paired,
        })
      ).status,
    ).toBe(409);
    const staged = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
      body: { ...body, request: REQUEST },
      ...paired,
    });
    expect(staged.status).toBe(201);
    const stage = staged.json<{ stage: `st_${string}` }>().stage;
    const index = JSON.parse(h.state('accounts').raw(stateDef('accounts')) ?? '{}') as AccountIndexDocument;
    allowed = addTwoFactorKeySubject(index.accounts.REVIEW!.key, stage);
    const saved = await h.request('POST', `/v1/accounts/REVIEW/factors/seed/${stage}/commit`, paired);
    expect(saved.status).toBe(200);
    expect(typed).toEqual([{ request: REQUEST, account: 'REVIEW', observedDigest: 'digest-as-the-owner-saw-it' }]);
    expect(saved.body).not.toContain(SEED);
  } finally {
    await h.stop();
  }
});

// ─── finding 4: project defaults ────────────────────────────────────────────────────────────────────────────────

it('I184 a project default orders a sign-in by the project the Board names and Projects registers', async () => {
  const ferrets = {
    list: async () => [],
    get: async () => undefined,
    workFolder: async () => ({ folder: '/work/app' }),
  };
  const board = { projectOf: async (ferret: string) => (ferret === 'F1' ? 'p1' : 'unfiled') };
  const projects = { list: async () => [{ id: 'p1', name: 'App', path: '/work/app' }] };
  let who: ReturnType<typeof ownerStanding> = ownerStanding();
  const h = await placedHost(
    {
      ferrets,
      board,
      projects,
      config: { 'accounts.yaml': { projects: { p1: { 'example.com': 'TWO' } } } },
    },
    new StandInAdmission(() => who),
  );
  try {
    for (const id of ['ONE', 'TWO']) {
      expect(
        (await h.request('PUT', `/v1/accounts/${id}`, { body: { label: id, username: id, password: PASSWORD } }))
          .status,
      ).toBe(200);
      expect(
        (
          await h.request('POST', `/v1/accounts/${id}/sign-ins`, {
            body: { place: { kind: 'site', domains: ['example.com'], match: ['example.com'] } },
          })
        ).status,
      ).toBe(200);
    }
    // The project is read from the credential-derived ferret, never from a field it sends.
    const hintAs = async (id: string) => {
      who = ferretStanding(id as never);
      const hint = await h.request('GET', '/v1/accounts/hint', { query: { site: 'example.com' }, as: ferret(id) });
      expect(hint.status).toBe(200);
      return hint.json<{ hints: { account: { id: string }; default?: { by: string; project?: string } }[] }>().hints;
    };
    const onProject = await hintAs('F1');
    expect(onProject.find(each => each.account.id === 'TWO')?.default).toEqual({ by: 'project', project: 'App' });
    expect(onProject.find(each => each.account.id === 'ONE')?.default).toBeUndefined();
    // A ferret on no project gets the site lines alone.
    expect((await hintAs('F9')).every(each => each.default === undefined)).toBe(true);
  } finally {
    await h.stop();
  }
});

// ─── finding 5: the 2FA key routes keep their own records ───────────────────────────────────────────────────────

it('S102 factor changes are kept secrets.changed records by account and key id, a seed save records proof passkey, none a value', async () => {
  const audits: AuditDraft[] = [];
  let allowed: string | undefined;
  const gate = new StandInAdmission(() => ({
    ...ownerStanding(),
    claimFreshStepUp: ((act: string, subject?: string) => act === 'add-2fa-key' && subject === allowed) as ReturnType<
      typeof ownerStanding
    >['claimFreshStepUp'],
  }));
  const h = await host({ audits, gate });
  try {
    await savedSignIn(h);
    audits.length = 0;
    const body = { padded: padInputValue(SEED), totpAcknowledged: true };
    const staged = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', { body });
    const stage = staged.json<{ stage: `st_${string}` }>().stage;
    const index = JSON.parse(h.state('accounts').raw(stateDef('accounts')) ?? '{}') as AccountIndexDocument;
    // Without the passkey proof the commit is refused, and the refusal is a kept record too.
    expect((await h.request('POST', `/v1/accounts/REVIEW/factors/seed/${stage}/commit`)).status).toBe(403);
    allowed = addTwoFactorKeySubject(index.accounts.REVIEW?.key as never, stage);
    const saved = await h.request('POST', `/v1/accounts/REVIEW/factors/seed/${stage}/commit`);
    expect(saved.status).toBe(200);
    const factor = saved.json<{ factor: { id: string } }>().factor.id;
    const added = await h.request('POST', '/v1/accounts/REVIEW/factors', { body: { kind: 'push', label: 'Phone' } });
    expect(added.status).toBe(201);
    const pushId = added.json<{ id: string }>().id;
    expect(
      (await h.request('PATCH', `/v1/accounts/REVIEW/factors/${pushId}`, { body: { label: 'Phone 2' } })).status,
    ).toBe(200);
    expect((await h.request('DELETE', `/v1/accounts/REVIEW/factors/${pushId}`)).status).toBe(200);
    expect((await h.request('DELETE', '/v1/accounts/REVIEW/factors/tf_000000000000')).status).toBe(404);

    const kept = audits.map(entry => ({
      event: entry.event,
      subject: entry.subject,
      actor: entry.actor,
      outcome: entry.outcome,
      detail: entry.detail,
    }));
    const host = { kind: 'host' };
    expect(kept as unknown[]).toEqual([
      {
        event: 'secrets.changed',
        subject: 'REVIEW',
        actor: host,
        outcome: 'succeeded',
        detail: { action: 'factor-seed-staged', stage },
      },
      {
        event: 'secrets.changed',
        subject: 'REVIEW',
        actor: host,
        outcome: 'refused',
        detail: { action: 'factor-added', code: STEP_UP_REQUIRED_CODE },
      },
      {
        event: 'secrets.changed',
        subject: 'REVIEW',
        actor: host,
        outcome: 'succeeded',
        detail: { action: 'factor-added', proof: 'passkey', factor },
      },
      {
        event: 'secrets.changed',
        subject: 'REVIEW',
        actor: host,
        outcome: 'succeeded',
        detail: { action: 'factor-added', factor: pushId },
      },
      {
        event: 'secrets.changed',
        subject: 'REVIEW',
        actor: host,
        outcome: 'succeeded',
        detail: { action: 'factor-relabelled', factor: pushId },
      },
      {
        event: 'secrets.changed',
        subject: 'REVIEW',
        actor: host,
        outcome: 'succeeded',
        detail: { action: 'factor-removed', factor: pushId },
      },
      {
        event: 'secrets.changed',
        subject: 'REVIEW',
        actor: host,
        outcome: 'refused',
        detail: { action: 'factor-removed', code: 'unknown_2fa_key' },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(SEED);
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
    // The route keeps its own record, so Gate's generic route record is not a second one.
    for (const key of [
      'POST /v1/accounts/:id/factors',
      'PATCH /v1/accounts/:id/factors/:factor',
      'DELETE /v1/accounts/:id/factors/:factor',
      'POST /v1/accounts/:id/factors/seed/:stage/commit',
    ])
      expect(accounts.manifest.actions.routes.find(route => route.key === key)?.audit).toHaveProperty('skip');
  } finally {
    await h.stop();
  }
});
