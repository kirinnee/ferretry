import { describe, it } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ApiRequest, ApiResponse, CallContext, FerretId } from '@ferretry/kernel/contract';
import { device, ferret, owner, testArrival, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import { addTwoFactorKeySubject, padInputValue } from '../../../contract/routes/index.ts';
import { AccountsPort } from '../../../contract/index.ts';
import accounts from '../../../daemon/index.ts';
import { accountRoutes } from '../../../daemon/routes/accounts.ts';
import { TwoFactorSeedStages } from './lib.ts';
import {
  CountingSealed,
  daemonOver,
  FakeSecretCipher,
  MemoryLoginIndex,
  NamedSealedDocuments,
  SEED,
} from './support.ts';

/**
 * The `/v1/accounts` routes of half a (today's `runtime/mounts/accounts-routes`, `factor-seed-routes` and
 * `account-defaults` tests, the parts that run without the Vault's sealed store). The real half is driven through the
 * kernel's test host; the seed commit, which needs a sealed store the Vault does not offer yet, is driven on the route
 * table directly with Gate's test standings.
 */

const host = async () =>
  await testHost({
    plugins: [accounts],
    fakes: { vault: new FakeVault(), asks: new FakeAsks(), sealed: new NamedSealedDocuments() },
  });

const F1 = 'F1' as FerretId;

describe('the account routes through the kernel', () => {
  it('S77 I176 should refuse every ferret write before the body is read, writing nothing', async () => {
    const h = await host();
    for (const [method, path] of [
      ['PUT', '/v1/accounts/GITHUB'],
      ['POST', '/v1/accounts/GITHUB/sign-ins'],
      ['POST', '/v1/accounts/GITHUB/factors'],
      ['DELETE', '/v1/accounts/GITHUB'],
    ] as const) {
      const refused = await h.request(method, path, { body: 'not json at all', as: ferret('F1') });
      should(refused.status).equal(403);
    }
    should(h.state('accounts').files.size).equal(0);
  });

  it('S78 S134 I126 should list which fields exist and never a value, and say ready', async () => {
    const h = await host();
    should(
      (await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub', username: 'kirin' } })).status,
    ).equal(200);
    const added = await h.request('POST', '/v1/accounts/GITHUB/sign-ins', {
      body: { place: { kind: 'site', domains: ['github.com'], match: ['github.com'] } },
    });
    should(added.status).equal(200);
    const listed = await h.request('GET', '/v1/accounts');
    should(listed.status).equal(200);
    const body = listed.json<{ health: string; accounts: { id: string; fields: unknown }[]; signIns: unknown[] }>();
    should(body.health).equal('ready');
    should(body.accounts.map(account => account.id)).eql(['GITHUB']);
    should(body.accounts[0]?.fields).eql({ password: false });
    should(body.signIns).have.length(1);
  });

  it('S70 S134 should answer a damaged store as damaged, never as an empty list', async () => {
    const h = await host();
    const file = accounts.manifest.data.state.find(each => each.name === 'accounts');
    if (file === undefined) throw new Error('no accounts state file');
    h.state('accounts').plant(file, '{ this is not json');
    const listed = (await h.request('GET', '/v1/accounts')).json<{ health: string; diagnosis?: string }>();
    should(listed.health).equal('damaged');
    should(listed.diagnosis).be.a.String();
  });

  it('S13 I131 should give a ferret the hint for a site, and never which fields an account holds', async () => {
    const h = await host();
    await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub', username: 'kirin' } });
    await h.request('POST', '/v1/accounts/GITHUB/sign-ins', {
      body: { place: { kind: 'site', domains: ['github.com'], match: ['github.com'] } },
    });
    // `operator` admits a ferret (today's `meetsMinimum`): the hint is a ferret's read.
    const hint = await h.request('GET', '/v1/accounts/hint', {
      query: { site: 'https://github.com/login' },
      as: ferret('F1'),
    });
    should(hint.status).equal(200);
    should(hint.body).not.match(/"fields"|"seals?"|"totp"|"params"|"recipe"|"proposals"|"factors"/u);
    should(hint.json<{ site: string; hints: unknown[] }>()).match({ site: 'github.com' });
    const tool = await h.tool('account_hint', { site: 'github.com' }, { as: ferret('F1') });
    should(tool.isError ?? false).be.false();
    should(tool.text).containEql('(GITHUB)');
    should(tool.text).not.match(/seal|totp|recipe:/iu);
    // A page by name needs Browsers' page address, which its port does not carry yet: refused in words.
    should((await h.tool('account_hint', { name: 'app' }, { as: ferret('F1') })).isError).be.true();
  });

  it('S80 should refuse a ferret choosing a default before the body, and a line no sign-in could use', async () => {
    const h = await host();
    const refused = await h.request('PUT', '/v1/accounts/defaults', { body: 'nonsense', as: ferret('F1') });
    should(refused.status).equal(403);
    should(refused.json<{ code: string }>().code).equal('owner_only');
    await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub' } });
    const unusable = await h.request('PUT', '/v1/accounts/defaults', {
      body: { scope: 'sites', key: 'github.com', account: 'GITHUB' },
    });
    should(unusable.status).equal(409);
    should(unusable.json<{ code: string }>().code).equal('no_sign_in_here');
  });

  it('S79 S81 should write the owner’s line through the kernel, take it away again, and move it with a rename', async () => {
    const h = await host();
    await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub' } });
    await h.request('POST', '/v1/accounts/GITHUB/sign-ins', {
      body: { place: { kind: 'site', domains: ['github.com'], match: ['github.com'] } },
    });
    const set = await h.request('PUT', '/v1/accounts/defaults', {
      body: { scope: 'sites', key: 'github.com', account: 'GITHUB' },
    });
    should(set.status).equal(200);
    should(set.json<{ defaults: unknown }>().defaults).eql({ sites: { 'github.com': 'GITHUB' } });
    should((await h.request('POST', '/v1/accounts/GITHUB/rename', { body: { to: 'GITHUB_HOME' } })).status).equal(200);
    const moved = await h.request('PUT', '/v1/accounts/defaults', {
      body: { scope: 'sites', key: 'gitlab.com', account: null },
    });
    should(moved.json<{ defaults: unknown }>().defaults).eql({ sites: { 'github.com': 'GITHUB_HOME' } });
    const removed = await h.request('PUT', '/v1/accounts/defaults', {
      body: { scope: 'sites', key: 'github.com', account: null },
    });
    should(removed.status).equal(200);
    should(removed.json<{ defaults: { sites?: unknown } }>().defaults.sites ?? {}).eql({});
  });

  it('S92 should refuse a seed while no device holds a passkey, and answer an unported tool as not built', async () => {
    const h = await host();
    await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub' } });
    const seed = await h.request('POST', '/v1/accounts/GITHUB/factors/seed', {
      body: { padded: padInputValue(SEED), totpAcknowledged: true },
    });
    should(seed.status).equal(409);
    should(seed.json<{ code: string }>().code).equal('passkey_required');
    should((await h.request('GET', '/v1/accounts/look-alike')).json()).match({ v: 1, groups: [] });
    // A declared tool neither half answers yet says so, in the skeleton sentence.
    const tool = await h.tool('secure_list', {}, { as: ferret('F1') });
    should(tool.isError).be.true();
    should(tool.text).containEql('not built yet');
  });

  it('S99 should add, relabel and remove a 2FA key with no value and no passkey', async () => {
    const h = await host();
    await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub' } });
    const added = await h.request('POST', '/v1/accounts/GITHUB/factors', { body: { kind: 'sms', label: 'Phone' } });
    should(added.status).equal(201);
    const factor = added.json<{ id: string }>().id;
    should(
      (await h.request('PATCH', `/v1/accounts/GITHUB/factors/${factor}`, { body: { label: 'Work phone' } })).status,
    ).equal(200);
    should((await h.request('DELETE', `/v1/accounts/GITHUB/factors/${factor}`, { as: device('phone') })).status).equal(
      200,
    );
  });

  it('should answer the accounts port by place, never with a value', async () => {
    const h = await host();
    await h.request('PUT', '/v1/accounts/GITHUB', { body: { label: 'GitHub' } });
    await h.request('POST', '/v1/accounts/GITHUB/sign-ins', {
      body: { place: { kind: 'site', domains: ['github.com'], match: ['github.com'] } },
    });
    const port = h.provided(AccountsPort);
    should((await port.signInsFor('github.com')).map(signIn => signIn.account)).eql(['GITHUB']);
    should(await port.signInsFor('gitlab.com')).eql([]);
  });
});

// ─── the seed commit, on the route table ──────────────────────────────────────────────────────────────────────────

const request = (method: string, path: string, body?: unknown): ApiRequest => ({
  method,
  path,
  query: new Map(),
  headers: new Map(),
  arrival: testArrival(owner()),
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

async function seedWorld(passkeys = true) {
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  const { directory, vault } = daemonOver(index, sealed);
  await directory.putAccount('GITHUB', { label: 'GitHub' });
  const seeds = new TwoFactorSeedStages({
    accounts: directory,
    cipher: new FakeSecretCipher(),
    clock: { nowMs: () => 0 },
    anyPasskey: async () => passkeys,
    hostName: 'kirin-box',
  });
  const routes = accountRoutes({ accounts: directory, seeds, lookAlike: vault });
  const call = async (
    key: keyof typeof routes,
    path: string,
    params: Record<string, string>,
    standing = ownerStanding(),
    body?: unknown,
  ): Promise<ApiResponse> =>
    await routes[key]({
      request: request(key.split(' ')[0] ?? 'GET', path, body),
      params: new Map(Object.entries(params)),
      ...standing,
    } as CallContext);
  const stage = async (): Promise<`st_${string}`> => {
    const staged = await call('POST /v1/accounts/:id/factors/seed', '', { id: 'GITHUB' }, ownerStanding(), {
      padded: padInputValue(SEED),
      totpAcknowledged: true,
    });
    should(staged.status).equal(201);
    return (JSON.parse(String(staged.body)) as { stage: `st_${string}` }).stage;
  };
  return { directory, seeds, call, stage, index };
}

const bodyOf = (response: ApiResponse): { code?: string; demand?: { act?: string } } =>
  JSON.parse(String(response.body)) as { code?: string; demand?: { act?: string } };

describe('saving a 2FA seed', () => {
  it('S88 S91 I193 should ask the machine’s own token for a passkey too: nothing stands in for the proof', async () => {
    const w = await seedWorld();
    const stage = await w.stage();
    const refused = await w.call('POST /v1/accounts/:id/factors/seed/:stage/commit', '', { id: 'GITHUB', stage });
    should(refused.status).equal(403);
    should(bodyOf(refused)).match({ code: STEP_UP_REQUIRED_CODE, demand: { act: 'add-2fa-key' } });
    should((await w.directory.list()).accounts[0]?.factors ?? []).have.length(0);
  });

  it('S90 should save only with a proof bound to this account and this stage, once', async () => {
    const w = await seedWorld();
    const stage = await w.stage();
    const key = w.index.accounts.accounts.GITHUB?.key ?? '';
    const subject = addTwoFactorKeySubject(key, stage);
    const claimed: string[] = [];
    const proving = {
      ...ownerStanding(),
      claimFreshStepUp: ((act: string, given: string) => {
        claimed.push(`${act}:${given}`);
        return act === 'add-2fa-key' && given === subject;
      }) as ReturnType<typeof ownerStanding>['claimFreshStepUp'],
    };
    const saved = await w.call(
      'POST /v1/accounts/:id/factors/seed/:stage/commit',
      '',
      { id: 'GITHUB', stage },
      proving,
    );
    should(saved.status).equal(200);
    should(claimed).eql([`add-2fa-key:${subject}`]);
    should(String(saved.body)).not.containEql(SEED);
    // Used once: the stage is no longer waiting.
    const again = await w
      .call('POST /v1/accounts/:id/factors/seed/:stage/commit', '', { id: 'GITHUB', stage }, proving)
      .catch((error: unknown) => error as { status: number });
    should(again).match({ status: 404 });
  });

  it('S92 should refuse to stage a seed when no device holds a passkey', async () => {
    const w = await seedWorld(false);
    const refused = await w
      .call('POST /v1/accounts/:id/factors/seed', '', { id: 'GITHUB' }, ownerStanding(), {
        padded: padInputValue(SEED),
        totpAcknowledged: true,
      })
      .catch((error: unknown) => error as { status: number; code: string });
    should(refused).match({ status: 409, code: 'passkey_required' });
  });

  it('S96 S98 should refuse a ferret every stage route, and never answer the seed', async () => {
    const w = await seedWorld();
    const stage = await w.stage();
    const ferretCall = ferretStanding(F1);
    for (const key of [
      'GET /v1/accounts/seed-stages/:stage',
      'POST /v1/accounts/:id/factors/seed/:stage/commit',
      'DELETE /v1/accounts/:id/factors/seed/:stage',
    ] as const) {
      const refused = await w
        .call(key, '', { id: 'GITHUB', stage }, ferretCall)
        .catch((error: unknown) => error as { status: number });
      should(refused).match({ status: 403 });
    }
    const view = await w.call('GET /v1/accounts/seed-stages/:stage', '', { stage });
    should(String(view.body)).not.containEql(SEED);
  });

  it('S82 should refuse a ferret the look-alike groups, and give the owner handles only', async () => {
    const w = await seedWorld();
    const refused = await w
      .call('GET /v1/accounts/look-alike', '', {}, ferretStanding(F1))
      .catch((error: unknown) => error as { status: number });
    should(refused).match({ status: 403 });
    const groups = await w.call('GET /v1/accounts/look-alike', '', {});
    should(JSON.parse(String(groups.body))).match({ v: 1 });
  });
});

describe('a ferret reading the hint', () => {
  it('S13 I131 I165 should answer a ferret by site in the same shape whether or not an account signs in there', async () => {
    const w = await seedWorld();
    await w.directory.addSignIn('GITHUB', { place: { kind: 'site', domains: ['github.com'], match: ['github.com'] } });
    const routes = accountRoutes({ accounts: w.directory });
    const hintFor = async (site: string) => {
      const answer = await routes['GET /v1/accounts/hint']({
        request: { ...request('GET', '/v1/accounts/hint'), query: new Map([['site', [site]]]) },
        params: new Map(),
        ...ferretStanding(F1),
      } as CallContext);
      should(answer.status).equal(200);
      should(String(answer.body)).not.match(/"fields"|"seals?"|"totp"|"params"|"recipe"|"proposals"|"factors"/u);
      return JSON.parse(String(answer.body)) as { site: string; hints: unknown[]; passkeys: string };
    };
    const known = await hintFor('github.com');
    const unknown = await hintFor('gitlab.com');
    should(known).match({ site: 'github.com', passkeys: 'off' });
    should(known.hints).have.length(1);
    should(Object.keys(unknown).sort()).eql(Object.keys(known).sort());
    should(unknown.hints).eql([]);
  });
});
