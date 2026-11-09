import { describe, it } from 'bun:test';
import should from 'should';
import { accountRefusal, ProtocolAccountGateway } from '../../../cli/lib/account-gateway.ts';
import { ProtocolTwoFactorSeedGateway } from '../../../cli/lib/factor-gateway.ts';
import { ProtocolCopyGateway } from '../../../cli/lib/copy/gateway.ts';
import { FyHttpError } from '../../../cli/shell.ts';
import manifest from '../../../manifest.ts';

const AT = '2026-11-01T12:00:00.000Z';
const SI = `si_${'1'.repeat(16)}`;
const TF = `tf_${'2'.repeat(12)}`;
const PROPOSAL = `rp_${'3'.repeat(16)}`;
const STAGE = `st_${'4'.repeat(24)}`;

const ACCOUNT = {
  id: 'GITHUB_WORK',
  label: 'work github',
  fields: { password: true },
  factors: [],
  signIns: [],
  createdAt: AT,
  updatedAt: AT,
};
const SIGN_IN = {
  id: SI,
  account: 'GITHUB_WORK',
  place: { kind: 'site', domains: ['github.com'], match: [] },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
};
const FACTOR = { id: TF, label: 'phone', addedAt: AT, addedBy: 'owner', kind: 'security-key', automatic: false };

type Init = {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
};

/** A plugin client that records the route it was asked for and answers `reply` (or throws `fail`). */
function rig(reply: unknown, fail?: unknown) {
  const calls: { route: string; init: Init | undefined }[] = [];
  const client = {
    call: async <Answer>(route: string, init?: Init): Promise<Answer> => {
      calls.push({ route, init });
      if (fail !== undefined) throw fail;
      return reply as Answer;
    },
  };
  return { calls, client };
}

const declared = new Set(manifest.actions.routes.map(route => route.key as string));

describe('ProtocolAccountGateway', () => {
  it('should reach each account route by its manifest key, with its params and a parsed body', async () => {
    const { calls, client } = rig(undefined);
    const gateway = new ProtocolAccountGateway(client);
    const attempt = async (run: () => Promise<unknown>): Promise<void> => void (await run().catch(() => undefined));

    await attempt(async () => await gateway.list());
    await attempt(async () => await gateway.putAccount('GITHUB_WORK', { label: 'work github' }));
    await attempt(async () => await gateway.renameAccount('GITHUB_WORK', 'GITHUB_HOME'));
    await attempt(async () => await gateway.removeAccount('GITHUB_WORK'));
    await attempt(async () => await gateway.merge('GITHUB_WORK', 'GITHUB_OLD'));
    await attempt(async () => await gateway.apart('GITHUB_WORK', 'GITHUB_OLD'));
    await attempt(async () => await gateway.lookAlike());
    await attempt(async () => await gateway.hint('github.com'));
    await attempt(async () => await gateway.addSignIn('GITHUB_WORK', { place: SIGN_IN.place as never }));
    await attempt(async () => await gateway.putSignIn(SI, { autoApplyRecipe: true }));
    await attempt(async () => await gateway.removeSignIn(SI));
    await attempt(async () => await gateway.decideRecipe(SI, PROPOSAL, 'approve'));
    await attempt(async () => await gateway.putDefault({ scope: 'sites', key: 'github.com', account: 'GITHUB_WORK' }));
    await attempt(async () => await gateway.addFactor('GITHUB_WORK', { label: 'phone', kind: 'security-key' }));
    await attempt(async () => await gateway.removeFactor('GITHUB_WORK', TF));

    should(calls.map(call => call.route)).eql([
      'GET /v1/accounts',
      'PUT /v1/accounts/:id',
      'POST /v1/accounts/:id/rename',
      'DELETE /v1/accounts/:id',
      'POST /v1/accounts/:id/merge',
      'POST /v1/accounts/:id/apart',
      'GET /v1/accounts/look-alike',
      'GET /v1/accounts/hint',
      'POST /v1/accounts/:id/sign-ins',
      'PUT /v1/accounts/sign-ins/:signIn',
      'DELETE /v1/accounts/sign-ins/:signIn',
      'POST /v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId',
      'PUT /v1/accounts/defaults',
      'POST /v1/accounts/:id/factors',
      'DELETE /v1/accounts/:id/factors/:factor',
    ]);
    should(calls.map(call => call.route).filter(route => !declared.has(route))).eql([]);
    should(calls[1]?.init).eql({ params: { id: 'GITHUB_WORK' }, body: { label: 'work github' } });
    should(calls[2]?.init?.body).eql({ to: 'GITHUB_HOME' });
    should(calls[3]?.init).eql({ params: { id: 'GITHUB_WORK' } });
    should(calls[4]?.init).eql({ params: { id: 'GITHUB_WORK' }, body: { from: 'GITHUB_OLD' } });
    should(calls[5]?.init?.body).eql({ from: 'GITHUB_OLD' });
    should(calls[7]?.init).eql({ query: { site: 'github.com' } });
    should(calls[8]?.init?.params).eql({ id: 'GITHUB_WORK' });
    should(calls[9]?.init).eql({ params: { signIn: SI }, body: { autoApplyRecipe: true } });
    should(calls[10]?.init).eql({ params: { signIn: SI } });
    should(calls[11]?.init).eql({ params: { signIn: SI, proposalId: PROPOSAL }, body: { decision: 'approve' } });
    should(calls[12]?.init?.body).eql({ scope: 'sites', key: 'github.com', account: 'GITHUB_WORK' });
    should(calls[13]?.init).eql({
      params: { id: 'GITHUB_WORK' },
      body: { label: 'phone', kind: 'security-key' },
    });
    should(calls[14]?.init).eql({ params: { id: 'GITHUB_WORK', factor: TF } });
  });

  it('should parse what the daemon answers and return it', async () => {
    const gateway = (reply: unknown) => new ProtocolAccountGateway(rig(reply).client);
    const list = { v: 1, health: 'ready', accounts: [ACCOUNT], signIns: [SIGN_IN] };
    should(await gateway(list).list()).eql(list);
    should(await gateway(ACCOUNT).putAccount('GITHUB_WORK', {})).eql(ACCOUNT);
    should(await gateway(ACCOUNT).renameAccount('GITHUB_WORK', 'GITHUB_HOME')).eql(ACCOUNT);
    should(await gateway({ id: 'GITHUB_WORK', removed: true }).removeAccount('GITHUB_WORK')).eql({
      id: 'GITHUB_WORK',
      removed: true,
    });
    should(await gateway(ACCOUNT).merge('GITHUB_WORK', 'GITHUB_OLD')).eql(ACCOUNT);
    should(await gateway(ACCOUNT).apart('GITHUB_WORK', 'GITHUB_OLD')).eql(ACCOUNT);
    should(await gateway({ v: 1, groups: [['A_ONE', 'A_TWO']] }).lookAlike()).eql({
      v: 1,
      groups: [['A_ONE', 'A_TWO']],
    });
    should(await gateway({ v: 1, site: 'github.com', hints: [], passkeys: 'off' }).hint('github.com')).eql({
      v: 1,
      site: 'github.com',
      hints: [],
      passkeys: 'off',
    });
    should(await gateway(SIGN_IN).addSignIn('GITHUB_WORK', { place: SIGN_IN.place as never })).eql(SIGN_IN);
    should(await gateway(SIGN_IN).putSignIn(SI, {})).eql(SIGN_IN);
    should(await gateway({ id: SI, removed: true }).removeSignIn(SI)).eql({ id: SI, removed: true });
    should(await gateway(SIGN_IN).decideRecipe(SI, PROPOSAL, 'decline')).eql(SIGN_IN);
    should(
      await gateway({ defaults: { sites: { 'github.com': 'GITHUB_WORK' } } }).putDefault({
        scope: 'sites',
        key: 'github.com',
        account: null,
      }),
    ).eql({ defaults: { sites: { 'github.com': 'GITHUB_WORK' } } });
    should(await gateway(FACTOR).addFactor('GITHUB_WORK', { label: 'phone', kind: 'security-key' })).eql(FACTOR);
    should(await gateway({ account: 'GITHUB_WORK', factor: TF, removed: true }).removeFactor('GITHUB_WORK', TF)).eql({
      account: 'GITHUB_WORK',
      factor: TF,
      removed: true,
    });
  });

  it('should refuse a body the contract refuses, before sending it', async () => {
    const { calls, client } = rig(ACCOUNT);
    const gateway = new ProtocolAccountGateway(client);
    await should(gateway.renameAccount('GITHUB_WORK', 'not a handle')).be.rejected();
    await should(gateway.merge('GITHUB_WORK', 'lowercase')).be.rejected();
    should(calls).eql([]);
  });

  it('should refuse a reply the contract does not describe', async () => {
    const gateway = new ProtocolAccountGateway(rig({ id: 'GITHUB_WORK', password: 'hunter2hunter2' }).client);
    await should(gateway.putAccount('GITHUB_WORK', {})).be.rejected();
  });

  it("should say a ferret's 403 owner_only as one sentence of the owner's command", async () => {
    const refused = new ProtocolAccountGateway(
      rig(undefined, Object.assign(new Error('owner only'), { name: 'DaemonRefusal', status: 403, code: 'owner_only' }))
        .client,
    );
    const error = await refused.list().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    should(error).be.instanceOf(Error);
    should(error).not.be.instanceOf(FyHttpError);
    should((error as Error).message)
      .containEql("this is the owner's command")
      .and.containEql('(owner only)');
    should((error as Error).message).containEql('no other credential was tried');
  });

  it('should leave any other refusal as the daemon said it, code and all', async () => {
    const other = Object.assign(new Error('no such account'), { name: 'DaemonRefusal', status: 404, code: 'gone' });
    const error = await new ProtocolAccountGateway(rig(undefined, other).client).list().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    should(error).be.instanceOf(FyHttpError);
    should(error).match({ status: 404, code: 'gone', message: 'no such account' });
  });
});

describe('accountRefusal', () => {
  it('should pass anything that is not the daemon refusing through unchanged', () => {
    const plain = new Error('boom');
    should(accountRefusal(plain)).equal(plain);
    should(accountRefusal('text')).equal('text');
  });

  it('should keep a 403 with another code, and another status with the owner_only code', () => {
    const forbidden = new FyHttpError('step up', 403, 'step_up_required');
    const notForbidden = new FyHttpError('odd', 400, 'owner_only');
    should(accountRefusal(forbidden)).equal(forbidden);
    should(accountRefusal(notForbidden)).equal(notForbidden);
  });
});

describe('ProtocolTwoFactorSeedGateway', () => {
  const STAGED = {
    stage: STAGE,
    account: 'GITHUB_WORK',
    label: 'authenticator',
    expiresAt: AT,
    parsed: { params: { algorithm: 'SHA1', digits: 6, period: 30 } },
  };
  const CONFIRMING = { stage: STAGE, session: 'session-one', agendaItemId: 'A7' };
  const VIEW = { stage: STAGE, account: 'GITHUB_WORK', label: 'authenticator', state: 'waiting', expiresAt: AT };

  it('should stage, confirm in the app and view through the seed routes the manifest declares', async () => {
    const stage = rig(STAGED);
    const staged = await new ProtocolTwoFactorSeedGateway(stage.client).stage('GITHUB_WORK', {
      padded: '00006:JBSWY3',
      totpAcknowledged: true,
      label: 'authenticator',
    });
    should(staged.stage).equal(STAGE);
    should(stage.calls[0]).match({
      route: 'POST /v1/accounts/:id/factors/seed',
      init: { params: { id: 'GITHUB_WORK' }, body: { padded: '00006:JBSWY3', totpAcknowledged: true } },
    });

    const confirm = rig(CONFIRMING);
    should(
      await new ProtocolTwoFactorSeedGateway(confirm.client).confirmInApp('GITHUB_WORK', STAGE, {
        session: 'session-one',
      }),
    ).eql(CONFIRMING);
    should(confirm.calls[0]).eql({
      route: 'POST /v1/accounts/:id/factors/seed/:stage/confirm-in-app',
      init: { params: { id: 'GITHUB_WORK', stage: STAGE }, body: { session: 'session-one' } },
    });

    const view = rig(VIEW);
    should(await new ProtocolTwoFactorSeedGateway(view.client).view('GITHUB_WORK', STAGE)).eql(VIEW);
    should(view.calls[0]).eql({
      route: 'GET /v1/accounts/:id/factors/seed/:stage',
      init: { params: { id: 'GITHUB_WORK', stage: STAGE } },
    });

    should([stage, confirm, view].flatMap(r => r.calls.map(call => call.route)).filter(r => !declared.has(r))).eql([]);
  });

  it('should refuse a stage body the contract refuses, and a reply it does not describe', async () => {
    const { calls, client } = rig(STAGED);
    const gateway = new ProtocolTwoFactorSeedGateway(client);
    await should(gateway.stage('GITHUB_WORK', { padded: '', totpAcknowledged: true })).be.rejected();
    should(calls).eql([]);
    await should(
      new ProtocolTwoFactorSeedGateway(rig({ stage: 'nope' }).client).view('GITHUB_WORK', STAGE),
    ).be.rejected();
  });
});

describe('ProtocolCopyGateway profile targets', () => {
  const PROFILE_STAGED = {
    stage: `prs_${'2'.repeat(24)}`,
    kind: 'profile-targets',
    does: 'Paste rules may then paste into programs from your own profile.',
    rows: [{ label: 'Widens', value: 'what gh prints → vercel in a terminal' }],
    runsAnything: false,
    expiresAt: AT,
  };

  it('should stage the profile targets switch through its own route and parse the stage', async () => {
    const { calls, client } = rig(PROFILE_STAGED);
    const staged = await new ProtocolCopyGateway(client).stageProfileTargets();
    should(staged).match({ stage: PROFILE_STAGED.stage, kind: 'profile-targets', runsAnything: false });
    should(calls).eql([{ route: 'POST /v1/copy-rules/settings/stages', init: undefined }]);
    should(declared.has(calls[0]?.route ?? '')).be.true();
  });

  it('should refuse a stage the contract does not describe', async () => {
    await should(new ProtocolCopyGateway(rig({ stage: 'nope' }).client).stageProfileTargets()).be.rejected();
  });
});
