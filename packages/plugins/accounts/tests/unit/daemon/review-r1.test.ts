import { expect, it } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeRedaction, FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { type AuditDraft, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { deviceStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { Admission } from '@ferretry/kernel/contract';
import type { ConfigFileDef, StateFileDef } from '@ferretry/kernel/contract';
import { ferret, fixedClock, testHost, type TestHost } from '@ferretry/kernel/testing';
import { DevicesChanged } from '@ferretry/plugin-access/contract';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../../core/kernel/host/state/memory-fs.ts';
import type { Log } from '@ferretry/kernel/contract';
import type { MaskSource } from '@ferretry/core-vault/contract';
import accounts from '../../../daemon/index.ts';
import type { AccountsConfig } from '../../../contract/index.ts';
import {
  AccountProposeCallSchema,
  type AccountIndexDocument,
  addTwoFactorKeySubject,
  padInputValue,
  type SignInSummary,
  type StoredStepUpProof,
} from '../../../contract/routes/index.ts';
import { proposalTarget } from '../../../daemon/lib/secrets/proposal-target.ts';
import { DEVICE, tappedFact, world, approved, type FakeProofs } from './sign-in-rules/support.ts';

const PASSWORD = 'synthetic-accounts-review-password';
const SEED = 'JBSWY3DPEHPK3PXP';
const RP = 'rp_0000000000000001';
const fakeGate = { audit: async (_entry: AuditDraft) => undefined };
const security = {
  devices: async () => [{ id: DEVICE }],
  holdsPasskey: async (device: string) => device === DEVICE,
};

async function host(secrets: string[] = [], access: unknown = security, gate?: Admission, audits?: AuditDraft[]) {
  return await testHost({
    plugins: [accounts],
    secrets,
    ...(gate === undefined ? {} : { gate }),
    clock: fixedClock('2026-11-01T12:00:00.000Z'),
    uses: access === null ? {} : { access },
    fakes: {
      vault: new FakeVault(),
      sealed: new FakeSealedDocuments(),
      asks: new FakeAsks(),
      gate: audits === undefined ? fakeGate : { audit: async (entry: AuditDraft) => void audits.push(entry) },
    },
  });
}

const indexDef = accounts.manifest.data.state.find(file => file.name === 'accounts') as StateFileDef;
const readIndex = (h: TestHost): AccountIndexDocument => JSON.parse(h.state('accounts').raw(indexDef) ?? '{}');
const plantIndex = (h: TestHost, document: AccountIndexDocument) =>
  h.state('accounts').plant(indexDef, JSON.stringify(document));

async function signIn(h: TestHost, recipe?: string): Promise<SignInSummary> {
  expect(
    (
      await h.request('PUT', '/v1/accounts/REVIEW', {
        body: { label: 'Review', username: 'fixture', password: PASSWORD },
      })
    ).status,
  ).toBe(200);
  const added = await h.request('POST', '/v1/accounts/REVIEW/sign-ins', {
    body: {
      place: { kind: 'site', domains: ['example.com'], match: ['example.com'] },
      ...(recipe === undefined ? {} : { recipe }),
    },
  });
  expect(added.status).toBe(200);
  return added.json<SignInSummary>();
}

// §10.4: real Accounts, Vault's contract fake. Day-5 integration tests the two real halves together.
it('S10 supplies saved passwords and staged seeds to Vault through the declared live redaction source', async () => {
  let source: MaskSource | undefined;
  const fakeVault = new FakeVault();
  const half = {
    ...accounts,
    build: (ctx: Parameters<NonNullable<typeof accounts.build>>[0]) => {
      const built = accounts.build!(ctx);
      source = built.hooks['redaction.sources:source'];
      return built;
    },
  };
  const gate = new StandInAdmission(() => ({ ...ownerStanding(), claimFreshStepUp: () => true }));
  const h = await testHost({
    plugins: [half],
    uses: { access: security },
    gate,
    fakes: { vault: fakeVault, sealed: new FakeSealedDocuments(), asks: new FakeAsks(), gate: fakeGate },
    redaction: { read: async run => new FakeRedaction(await source!.values()).read(run) },
  });
  try {
    await signIn(h);
    expect(
      accounts.manifest.hooks.takes.some(take => take.hook.name === 'redaction.sources' && take.key === 'source'),
    ).toBe(true);
    expect((await source!.values()).get('login:REVIEW:password')).toBe(PASSWORD);
    expect(await new FakeRedaction(await source!.values()).read(scope => scope.text(PASSWORD))).toBe(
      '[redacted:login:REVIEW:password]',
    );
    const staged = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
      body: { padded: padInputValue(SEED), totpAcknowledged: true },
    });
    expect(staged.status).toBe(201);
    const values = await source!.values();
    expect([...values].some(([label, value]) => label.startsWith('2fa:') && value === SEED)).toBe(true);
    expect(await new FakeRedaction(values).read(scope => scope.text(SEED))).toMatch(/^\[redacted:2fa:/u);
    const stage = staged.json<{ stage: string }>().stage;
    expect((await h.request('POST', `/v1/accounts/REVIEW/factors/seed/${stage}/commit`)).status).toBe(200);
    expect((await source!.values()).get('login:REVIEW:totp')).toBe(SEED);
    expect(await fakeVault.names()).toEqual([]);
    expect((await fakeVault.childEnvironment('F1' as never, { LOGIN: '${secret:REVIEW}' })).ok).toBe(false);
    expect((await h.request('GET', '/v1/accounts')).body).not.toContain(PASSWORD);
  } finally {
    await h.stop();
  }
});

it('I126 the owner listing exposes presence only, and saved accounts cannot resolve as Vault secrets', async () => {
  const fakeVault = new FakeVault();
  const h = await testHost({
    plugins: [accounts],
    fakes: { vault: fakeVault, sealed: new FakeSealedDocuments(), asks: new FakeAsks(), gate: fakeGate },
  });
  try {
    await signIn(h);
    const response = await h.request('GET', '/v1/accounts');
    expect(response.body).not.toContain(PASSWORD);
    expect(response.json<{ accounts: { fields: unknown }[] }>().accounts[0]?.fields).toEqual({ password: true });
    expect((await fakeVault.childEnvironment('F1' as never, { VALUE: '${secret:REVIEW}' })).ok).toBe(false);
  } finally {
    await h.stop();
  }
});

const configDef = accounts.manifest.data.config[0] as ConfigFileDef<AccountsConfig>;
function configWorld() {
  const fs = createMemoryHostFs();
  let confirmed = false;
  const log: Log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  const files = createConfigFiles({
    home: '/accounts-test-only',
    fs,
    clock: fixedClock(),
    log,
    binary: 'fy',
    defs: [{ plugin: 'accounts', def: configDef }],
    judge: () => confirmed,
  });
  const path = '/accounts-test-only/config/accounts.yaml';
  return {
    fs,
    files,
    path,
    confirm: (value: boolean) => {
      confirmed = value;
    },
    port: files.port('accounts'),
  };
}

it('S79 holds raw disk additions, changes, removals and deletion of account defaults', async () => {
  const w = configWorld();
  await w.files.reload();
  w.fs.seed(w.path, 'sites:\n  example.com: REVIEW\n');
  await w.files.reload();
  expect(w.port.file(configDef)?.sites).toBeUndefined();
  expect(w.port.fileState(configDef).state).toBe('held');
  w.confirm(true);
  expect((await w.port.write(configDef, undefined, 'sites:\n  example.com: ORIGINAL\n')).kind).toBe('written');
  w.confirm(false);
  for (const edit of ['sites:\n  example.com: CHANGED\n', '{}\n']) {
    w.fs.seed(w.path, edit);
    await w.files.reload();
    expect(w.port.file(configDef)?.sites).toEqual({ 'example.com': 'ORIGINAL' });
    expect(w.port.fileState(configDef).state).toBe('held');
  }
  await w.fs.remove(w.path);
  await w.files.reload();
  expect(w.port.file(configDef)?.sites).toEqual({ 'example.com': 'ORIGINAL' });
  expect(w.port.fileState(configDef).state).toBe('held');
});

it('S79 holds unconfirmed writer edits in every scope and leaves the confirmed defaults effective', async () => {
  const w = configWorld();
  await w.files.reload();
  for (const edit of [
    'sites:\n  example.com: REVIEW\n',
    'projects:\n  demo:\n    example.com: REVIEW\n',
    'folders:\n  /work:\n    example.com: REVIEW\n',
  ]) {
    expect((await w.port.write(configDef, undefined, edit)).kind).toBe('held');
    expect(w.port.file(configDef) ?? {}).toEqual({});
  }
  w.confirm(true);
  await w.port.write(configDef, undefined, 'sites:\n  example.com: REVIEW\n');
  w.confirm(false);
  expect((await w.port.write(configDef, undefined, '{}\n')).kind).toBe('held');
  expect(w.port.file(configDef)?.sites).toEqual({ 'example.com': 'REVIEW' });
});

it('S79 the owner removal-only route needs no passkey while adding a default from that device still does', async () => {
  let remote = false;
  const gate = Object.assign(
    new StandInAdmission(() =>
      remote
        ? {
            ...deviceStanding(DEVICE),
            governance: { governed: true, decide: () => ({ allowed: true as const, refusal: 'granted' as const }) },
          }
        : ownerStanding(),
    ),
    { judgeConfigWrite: () => 'apply' as const },
  );
  const h = await host([], security, gate);
  try {
    await signIn(h);
    const path = '/v1/accounts/defaults';
    const line = { scope: 'sites', key: 'example.com', account: 'REVIEW' };
    expect((await h.request('PUT', path, { body: line })).status).toBe(200);
    remote = true;
    expect((await h.request('PUT', path, { body: { ...line, account: null } })).status).toBe(200);
    const added = await h.request('PUT', path, { body: line });
    expect(added.status).toBe(403);
    expect(added.json<{ code: string }>().code).toBe(STEP_UP_REQUIRED_CODE);
  } finally {
    await h.stop();
  }
});

/** ONE fresh passkey proof (Gate's registry): `claim` takes it in one step, so exactly one claim ever wins. */
function oneFreshProof() {
  let held = true;
  let taken = 0;
  const claim = (() => {
    if (!held) return false;
    held = false;
    taken += 1;
    return true;
  }) as ReturnType<typeof ownerStanding>['claimFreshStepUp'];
  return { claim, taken: () => taken };
}

/** A governed device the admission snapshot says is FRESH, sharing `proof` with every other call built on it. */
function freshDevice(proof: ReturnType<typeof oneFreshProof>) {
  const base = deviceStanding(DEVICE);
  return {
    ...base,
    presentation: { ...base.presentation, stepUp: true, freshStepUp: true },
    governance: { governed: true, decide: () => ({ allowed: true as const, refusal: 'granted' as const }) },
    claimFreshStepUp: proof.claim,
  };
}

async function defaultsHost(standing: () => ReturnType<typeof freshDevice> | ReturnType<typeof ownerStanding>) {
  const gate = Object.assign(new StandInAdmission(standing), { judgeConfigWrite: () => 'apply' as const });
  const h = await host([], security, gate);
  await signIn(h);
  return h;
}

const defaultLine = (key: string) => ({ scope: 'sites', key, account: 'REVIEW' });

it('S79 two account-default edits admitted on ONE fresh proof, both snapshotted fresh: exactly one is written, the other asks again and writes nothing', async () => {
  const proof = oneFreshProof();
  const h = await defaultsHost(() => freshDevice(proof));
  try {
    const answers = await Promise.all([
      h.request('PUT', '/v1/accounts/defaults', { body: defaultLine('example.com') }),
      h.request('PUT', '/v1/accounts/defaults', { body: defaultLine('example.com') }),
    ]);
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 403]);
    const refused = answers.find(answer => answer.status === 403);
    expect(refused?.json<{ code: string; demand: { act: string } }>()).toMatchObject({
      code: STEP_UP_REQUIRED_CODE,
      demand: { act: 'loosen-config' },
    });
    const written = answers.find(answer => answer.status === 200);
    expect(written?.json<{ defaults: { sites?: Record<string, string> } }>().defaults.sites).toEqual({
      'example.com': 'REVIEW',
    });
    expect(proof.taken()).toBe(1);
  } finally {
    await h.stop();
  }
});

it('S79 an account-default edit and a config loosening claiming the same fresh proof first: exactly one acts, nothing is written', async () => {
  const proof = oneFreshProof();
  const h = await defaultsHost(() => freshDevice(proof));
  try {
    // The other act takes the proof through the claim every admitted call carries, as Gate's judge does.
    const loosening = proof.claim?.() === true ? 'apply' : 'hold';
    const answer = await h.request('PUT', '/v1/accounts/defaults', { body: defaultLine('example.com') });
    expect([loosening, answer.status]).toEqual(['apply', 403]);
    expect(proof.taken()).toBe(1);
  } finally {
    await h.stop();
  }
});

it('S79 one fresh proof and no race: the edit is written and the proof is gone, so the next edit asks again', async () => {
  const proof = oneFreshProof();
  const h = await defaultsHost(() => freshDevice(proof));
  try {
    const first = await h.request('PUT', '/v1/accounts/defaults', { body: defaultLine('example.com') });
    const next = await h.request('PUT', '/v1/accounts/defaults', { body: defaultLine('example.com') });
    expect([first.status, next.status]).toEqual([200, 403]);
    expect(proof.taken()).toBe(1);
  } finally {
    await h.stop();
  }
});

it('S79 the owner at the machine, and a removal from a device, claim no proof at all', async () => {
  const proof = oneFreshProof();
  let remote = false;
  const h = await defaultsHost(() =>
    remote ? freshDevice(proof) : { ...ownerStanding(), claimFreshStepUp: proof.claim },
  );
  try {
    expect((await h.request('PUT', '/v1/accounts/defaults', { body: defaultLine('example.com') })).status).toBe(200);
    remote = true;
    const removal = await h.request('PUT', '/v1/accounts/defaults', {
      body: { ...defaultLine('example.com'), account: null },
    });
    expect(removal.status).toBe(200);
    expect(proof.taken()).toBe(0);
  } finally {
    await h.stop();
  }
});

it('S134 a damaged accounts index is shown as damaged and never presented as an empty healthy listing', async () => {
  const h = await host();
  try {
    await signIn(h);
    h.state('accounts').plant(indexDef, '{');
    const response = await h.request('GET', '/v1/accounts');
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ health: 'damaged', accounts: [], signIns: [] });
    expect(response.json<{ diagnosis: string }>().diagnosis).toBeTruthy();
    expect(response.body).not.toContain(PASSWORD);
  } finally {
    await h.stop();
  }
});

it('I133 late-built recipes check creation and updates, and scrub listing, hint and metadata-only replies at read time', async () => {
  const masked: string[] = [];
  const h = await host(masked);
  try {
    const added = await signIn(h, 'Click sign in, then fixture-text');
    expect(added.recipe).toBe('Click sign in, then fixture-text');
    masked.push('fixture-text');
    const listed = await h.request('GET', '/v1/accounts');
    expect(listed.body).not.toContain('fixture-text');
    const updated = await h.request('PUT', `/v1/accounts/sign-ins/${added.id}`, { body: { autoApplyRecipe: true } });
    expect(updated.status).toBe(200);
    expect(updated.body).not.toContain('fixture-text');
    const hint = await h.tool('account_hint', { site: 'example.com' }, { as: ferret('F1') });
    expect(hint.text).not.toContain('fixture-text');
    expect(
      (await h.request('PUT', `/v1/accounts/sign-ins/${added.id}`, { body: { recipe: 'Type fixture-text' } })).status,
    ).toBe(400);
  } finally {
    await h.stop();
  }
});

it('S92 a paired passkey enables staging through the composed Accounts daemon; a missing provider refuses', async () => {
  for (const [access, status] of [
    [security, 201],
    [null, 409],
    [{ ...security, holdsPasskey: async () => false }, 409],
  ] as const) {
    const h = await host([], access);
    try {
      await signIn(h);
      const staged = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
        body: { padded: padInputValue(SEED), totpAcknowledged: true },
      });
      expect(staged.status).toBe(status);
      expect(staged.body).not.toContain(SEED);
    } finally {
      await h.stop();
    }
  }
});

it('S120 stored rule validation calls Access with the registered credential and the challenge derived from the signed body', async () => {
  let proofs: FakeProofs | undefined;
  const audits: AuditDraft[] = [];
  const h = await host(
    [],
    {
      ...security,
      holds: async (device: string, credential: string) => (await proofs?.holds(device, credential)) ?? false,
      verifyStoredProof: async (proof: StoredStepUpProof, challenge: Uint8Array) =>
        (await proofs?.verify(proof, challenge)) ?? false,
    },
    new StandInAdmission(() => ownerStanding()),
    audits,
  );
  try {
    const added = await signIn(h);
    const index = readIndex(h);
    plantIndex(h, {
      ...index,
      signIns: { ...index.signIns, [added.id]: { ...index.signIns[added.id]!, observed: [tappedFact('example.com')] } },
    });
    const listing = (await h.request('GET', '/v1/accounts')).json<{ accounts: never[]; signIns: SignInSummary[] }>();
    const w = await world({ listing: { ...listing, keys: new Map([['REVIEW', index.accounts.REVIEW!.key]]) } });
    proofs = w.proofs;
    await approved(w, { signIn: added.id, fields: ['password'] });
    const saved = w.store.document;
    if (saved === undefined) throw new Error('fixture missing');
    const def = accounts.manifest.data.state.find(file => file.name === 'sign-in-rules')!;
    h.state('accounts').plant(def, JSON.stringify({ format: 1, ...saved }));
    const before = w.proofs.checks;
    await h.runJob('accounts.sign-in-rules');
    expect(w.proofs.checks).toBeGreaterThan(before);
    const view = await h.request('GET', '/v1/sign-in-rules');
    expect(view.status).toBe(200);
    expect(view.body).not.toContain('proof-invalid');
    expect(view.json<{ rules: { suspended?: unknown }[] }>().rules[0]?.suspended).toBeUndefined();
    h.emit(DevicesChanged, { device: DEVICE, change: 'revoked' });
    await h.settle();
    expect(audits).toContainEqual(
      expect.objectContaining({
        event: 'security.changed',
        actor: { kind: 'host' },
        cause: 'daemon',
        outcome: 'succeeded',
        detail: expect.objectContaining({ action: 'sign-in-rule-suspended', because: 'passkey-removed' }),
      }),
    );
  } finally {
    await h.stop();
  }
});

it('S128 damaged rules keep the service security audit record with actor, outcome and action', async () => {
  const audits: AuditDraft[] = [];
  const h = await testHost({
    plugins: [accounts],
    fakes: {
      vault: new FakeVault(),
      sealed: new FakeSealedDocuments(),
      asks: new FakeAsks(),
      gate: { audit: async (entry: AuditDraft) => void audits.push(entry) },
    },
  });
  try {
    h.state('accounts').plant(accounts.manifest.data.state.find(file => file.name === 'sign-in-rules')!, '{');
    await h.runJob('accounts.sign-in-rules');
    expect(audits).toContainEqual(
      expect.objectContaining({
        event: 'security.changed',
        actor: { kind: 'host' },
        detail: expect.objectContaining({ action: 'sign-in-rules-damaged' }),
      }),
    );
    expect(audits[0]?.outcome).toBeDefined();
    expect(h.logs.some(line => line.message === 'accounts audit')).toBe(false);
  } finally {
    await h.stop();
  }
});

for (const decision of ['approve', 'decline'] as const) {
  it(`I140 the owner's ${decision} route decides the canonical proposal and closes its ask`, async () => {
    const asks = new FakeAsks();
    const h = await testHost({
      plugins: [accounts],
      fakes: { vault: new FakeVault(), sealed: new FakeSealedDocuments(), asks, gate: fakeGate },
    });
    try {
      const added = await signIn(h, 'Original steps');
      const index = readIndex(h);
      const record = index.signIns[added.id]!;
      const ask = await asks.raise({
        source: 'sign-in-approval' as never,
        entry: RP as never,
        ref: { kind: 'recipe-proposal', signIn: added.id, proposal: RP },
        kind: 'task',
        subject: 'Recipe',
        why: 'Recipe review',
        raisedBy: { kind: 'daemon' },
        ferret: 'F1' as never,
      });
      plantIndex(h, {
        ...index,
        signIns: {
          ...index.signIns,
          [added.id]: {
            ...record,
            proposals: [
              {
                id: RP,
                recipe: 'New steps',
                base: 'Original steps',
                why: 'Clearer',
                sessionId: 'F1',
                proposedAt: '2026-11-01T00:00:00.000Z',
                agendaItemId: ask.id,
              },
            ],
          },
        },
      });
      const response = await h.request('POST', `/v1/accounts/sign-ins/${added.id}/recipe/proposals/${RP}`, {
        body: { decision },
      });
      expect(response.status).toBe(200);
      expect(response.json<SignInSummary>().recipe).toBe(decision === 'approve' ? 'New steps' : 'Original steps');
      expect((await asks.get(ask))?.state).toBe('closed');
    } finally {
      await h.stop();
    }
  });
}

it('I140 rejects stale proposals and ferret decisions, preserving the current recipe', async () => {
  const h = await host();
  try {
    const added = await signIn(h, 'Current steps');
    const index = readIndex(h);
    plantIndex(h, {
      ...index,
      signIns: {
        ...index.signIns,
        [added.id]: {
          ...index.signIns[added.id]!,
          proposals: [
            {
              id: RP,
              recipe: 'New steps',
              base: 'Old steps',
              why: 'Clearer',
              sessionId: 'F1',
              proposedAt: '2026-11-01T00:00:00.000Z',
            },
          ],
        },
      },
    });
    const path = `/v1/accounts/sign-ins/${added.id}/recipe/proposals/${RP}`;
    expect((await h.request('POST', path, { body: 'invalid', as: ferret('F1') })).status).toBe(403);
    const stale = await h.request('POST', path, { body: { decision: 'approve' } });
    expect(stale.status).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('stale_proposal');
    expect(readIndex(h).signIns[added.id]?.recipe).toBe('Current steps');
  } finally {
    await h.stop();
  }
});

it('S84 rejects the removed account-only proposal selector and direct seed body at the canonical routes', async () => {
  const h = await host();
  try {
    const added = await signIn(h);
    const list = (await h.request('GET', '/v1/accounts')).json<{ accounts: never[]; signIns: never[] }>();
    expect(proposalTarget(list, { login: 'REVIEW' } as never).ok).toBe(false);
    expect(
      AccountProposeCallSchema.safeParse({ tool: 'account.propose', login: 'REVIEW', recipe: 'Steps', why: 'Clearer' })
        .success,
    ).toBe(false);
    expect(
      (await h.request('PUT', '/v1/accounts/REVIEW', { body: { totp: { seed: SEED }, totpAcknowledged: true } }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.request('PUT', `/v1/accounts/sign-ins/${added.id}`, {
          body: { totp: { seed: SEED }, totpAcknowledged: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.request('POST', '/v1/accounts/REVIEW/factors', { body: { kind: 'totp', seed: SEED } })).status,
    ).toBe(400);
  } finally {
    await h.stop();
  }
});

it('I128 the production sign-in route refuses passkey methods and SSO names for passkeys or security keys', async () => {
  const h = await host();
  try {
    const added = await signIn(h);
    for (const method of [
      { kind: 'passkey' },
      { kind: 'sso', name: 'Passkey' },
      { kind: 'sso', name: 'WebAuthn' },
      { kind: 'sso', name: 'Security key' },
    ]) {
      expect((await h.request('PUT', `/v1/accounts/sign-ins/${added.id}`, { body: { method } })).status).toBe(400);
    }
    expect(readIndex(h).signIns[added.id]?.method ?? { kind: 'password' }).toEqual({ kind: 'password' });
  } finally {
    await h.stop();
  }
});

it('I191 the daemon rejects malformed seed inputs without repeating any input in its refusal', async () => {
  const h = await host();
  try {
    await signIn(h);
    for (const text of [
      'SYNTHETIC-INVALID-SEED-0001',
      'otpauth://hotp/example?secret=JBSWY3DPEHPK3PXP',
      'otpauth://totp/example?secret=JBSWY3DPEHPK3PXP&digits=99',
      'otpauth://totp/example?secret=JBSWY3DPEHPK3PXP&algorithm=MD5',
      'https://example.com/setup?seed=JBSWY3DPEHPK3PXP',
    ]) {
      const response = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
        body: { padded: padInputValue(text), totpAcknowledged: true },
      });
      expect(response.status).toBe(400);
      expect(response.body).not.toContain(text);
      expect(response.body).not.toContain(SEED);
    }
  } finally {
    await h.stop();
  }
});

it('I192 an issuer/account mismatch requires the owner’s explicit save-here-anyway choice', async () => {
  const h = await host();
  try {
    await signIn(h);
    const padded = padInputValue(`otpauth://totp/Elsewhere%3Aanother-person?secret=${SEED}&issuer=Elsewhere`);
    const response = await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
      body: { padded, totpAcknowledged: true },
    });
    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('factor_mismatch');
    expect(
      (
        await h.request('POST', '/v1/accounts/REVIEW/factors/seed', {
          body: { padded, totpAcknowledged: true, mismatchAcknowledged: true },
        })
      ).status,
    ).toBe(201);
  } finally {
    await h.stop();
  }
});

it('S95 the staging route caps one caller at two waiting seeds', async () => {
  const h = await host();
  try {
    await signIn(h);
    const body = { padded: padInputValue(SEED), totpAcknowledged: true };
    // The same staging caller is capped at two before the daemon-wide cap.
    expect((await h.request('POST', '/v1/accounts/REVIEW/factors/seed', { body })).status).toBe(201);
    expect((await h.request('POST', '/v1/accounts/REVIEW/factors/seed', { body })).status).toBe(201);
    expect((await h.request('POST', '/v1/accounts/REVIEW/factors/seed', { body })).status).toBe(429);
  } finally {
    await h.stop();
  }
});

it('I193 a host admin token cannot save a seed without a fresh proof bound to that exact account and stage', async () => {
  let allowedSubject: string | undefined;
  const gate = new StandInAdmission(() => ({
    ...ownerStanding(),
    claimFreshStepUp: ((act: string, subject?: string) =>
      act === 'add-2fa-key' && subject === allowedSubject) as ReturnType<typeof ownerStanding>['claimFreshStepUp'],
  }));
  const h = await host([], security, gate);
  try {
    await signIn(h);
    const body = { padded: padInputValue(SEED), totpAcknowledged: true };
    const first = (await h.request('POST', '/v1/accounts/REVIEW/factors/seed', { body })).json<{
      stage: `st_${string}`;
    }>().stage;
    const second = (await h.request('POST', '/v1/accounts/REVIEW/factors/seed', { body })).json<{
      stage: `st_${string}`;
    }>().stage;
    const path = (stage: string) => `/v1/accounts/REVIEW/factors/seed/${stage}/commit`;
    expect((await h.request('POST', path(first))).status).toBe(403);
    allowedSubject = addTwoFactorKeySubject(readIndex(h).accounts.REVIEW!.key, first);
    expect((await h.request('POST', path(second))).status).toBe(403);
    expect(readIndex(h).accounts.REVIEW!.factors ?? []).toHaveLength(0);
    expect((await h.request('POST', path(first))).status).toBe(200);
    expect((await h.request('POST', path(first))).status).toBe(404);
  } finally {
    await h.stop();
  }
});
