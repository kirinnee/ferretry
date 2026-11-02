import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { DaemonFeaturesUnreadable, daemonNeedsUpdate } from '../../../src/lib/daemon/features';
import { ProtocolRulesGateway } from '../../../src/lib/rules/gateway';
import type { RulesApiClient } from '../../../src/lib/rules/ports';

const STAGE = `srs_${'a'.repeat(24)}`;
const SIGN_IN = `si_${'1'.repeat(16)}`;
const RULE = `sr_${'b'.repeat(24)}`;

const STAGED = {
  stage: STAGE,
  rule: RULE,
  revision: 1,
  signIn: SIGN_IN,
  account: { id: 'GITHUB_WORK', label: 'work github' },
  place: { kind: 'site', domains: ['github.com'], match: [] },
  does: 'Ferretry signs in to github.com as work github for any ferret, without asking.',
  rows: [
    { label: 'Site', value: 'github.com' },
    { label: 'Account', value: 'work github' },
    { label: 'Types', value: 'password' },
    { label: 'Who', value: 'Any ferret on this machine' },
    { label: 'Until', value: '2026-12-01 12:00 UTC' },
    { label: 'Uses', value: 'No limit' },
  ],
  fields: ['password'],
  totp: false,
  root: false,
  autoRecipe: false,
  scope: { kind: 'any' },
  expiresAt: '2026-12-01T12:00:00.000Z',
  stageExpiresAt: '2026-11-01T12:02:00.000Z',
};

const RULE_VIEW = {
  id: RULE,
  revision: 1,
  signIn: SIGN_IN,
  account: STAGED.account,
  place: STAGED.place,
  fields: ['password'],
  totp: false,
  scope: { kind: 'any' },
  createdAt: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-12-01T12:00:00.000Z',
  status: 'active',
  usage: { count: 0 },
  flags: [],
  approvedWith: { deviceId: `fy_device_id_${'1'.repeat(22)}` },
};

const headerNames = (init: RequestInit | undefined): string[] =>
  Object.keys((init?.headers ?? {}) as object).map(name => name.toLowerCase());

function rig(reply: unknown) {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const client: RulesApiClient = {
    request: async (path, schema, init) => {
      calls.push({ path, init });
      return schema.parse(reply);
    },
  };
  return { calls, gateway: new ProtocolRulesGateway(client) };
}

describe('ProtocolRulesGateway', () => {
  it('should offer no commit call and no way to name the commit route', () => {
    const names = Object.getOwnPropertyNames(ProtocolRulesGateway.prototype);
    should(names.filter(name => /commit|approve/iu.test(name))).eql([]);
  });

  it('should list, view and confirm on the stage routes, with the client header and no session header', async () => {
    const { calls, gateway } = rig({ health: 'ok', rules: [], stages: [] });
    await gateway.list();
    should(calls[0]?.path).equal('/v1/sign-in-rules');
    should(Object.keys((calls[0]?.init?.headers ?? {}) as object).map(name => name.toLowerCase())).not.containEql(
      'x-fy-session',
    );
  });

  it('should refuse a draft the protocol would refuse, before sending it', async () => {
    const { calls, gateway } = rig({});
    await gateway.stage({ signIn: SIGN_IN, fields: ['password'], totp: true }).then(
      () => should.fail('', '', 'sent an unacknowledged code'),
      () => undefined,
    );
    should(calls).eql([]);
  });

  it('should delete a stage and revoke a rule on their own routes', async () => {
    const dropped = rig({ stage: STAGE, dropped: true });
    await dropped.gateway.drop(STAGE);
    should(dropped.calls[0]).containEql({ path: `/v1/sign-in-rules/stages/${STAGE}` });
    should(dropped.calls[0]?.init?.method).equal('DELETE');
    const revoked = rig({ id: 'sr_x', revoked: true });
    await revoked.gateway.revoke('sr_x');
    should(revoked.calls[0]?.path).equal('/v1/sign-in-rules/sr_x');
  });

  it('should end every rule of an account on its own route, and read eligibility on its query', async () => {
    const ended = rig({ account: 'GITHUB_WORK', revoked: 3 });
    should(await ended.gateway.revokeAccount('GITHUB_WORK')).equal(3);
    should(ended.calls[0]?.path).equal('/v1/accounts/GITHUB_WORK/sign-in-rules/revoke');
    should(ended.calls[0]?.init?.method).equal('POST');
    should(headerNames(ended.calls[0]?.init)).not.containEql('x-fy-session');

    const asked = rig({ signIn: SIGN_IN, eligible: false, because: 'no-history' });
    const answer = await asked.gateway.eligibility(SIGN_IN);
    should(asked.calls[0]?.path).equal(`/v1/sign-in-rules/eligibility?signIn=${SIGN_IN}`);
    should(answer.eligible).equal(false);
  });

  it('should confirm a stage in the app and read its state on the stage routes', async () => {
    const confirmed = rig(STAGED);
    should((await confirmed.gateway.confirmInApp(STAGE)).stage).equal(STAGE);
    should(confirmed.calls[0]?.path).equal(`/v1/sign-in-rules/stages/${STAGE}/confirm-in-app`);
    should(confirmed.calls[0]?.init?.method).equal('POST');
    should(headerNames(confirmed.calls[0]?.init)).not.containEql('x-fy-session');

    const viewed = rig({ ...STAGED, state: 'denied' });
    should((await viewed.gateway.view(STAGE)).state).equal('denied');
    should(viewed.calls[0]?.path).equal(`/v1/sign-in-rules/stages/${STAGE}`);
    should(viewed.calls[0]?.init?.method).equal(undefined);
  });

  it('should send a staged draft as JSON on the stages route', async () => {
    const { calls, gateway } = rig(STAGED);
    await gateway.stage({ signIn: SIGN_IN, fields: ['password'], uses: 2 });
    should(calls[0]?.path).equal('/v1/sign-in-rules/stages');
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ signIn: SIGN_IN, fields: ['password'], uses: 2 });
    should(headerNames(calls[0]?.init)).containEql('content-type');
  });

  it('should narrow a rule on its own route, and refuse an empty narrowing before sending it', async () => {
    const { calls, gateway } = rig(RULE_VIEW);
    should((await gateway.narrow(RULE, { dropTotp: true })).id).equal(RULE);
    should(calls[0]?.path).equal(`/v1/sign-in-rules/${RULE}/narrow`);
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ dropTotp: true });
    await gateway.narrow(RULE, {}).then(
      () => should.fail('', '', 'sent an empty narrowing'),
      () => undefined,
    );
    should(calls).have.length(1);
  });

  it('should read the daemon features from its health, and say so when it cannot be read', async () => {
    const reported: RulesApiClient = { request: async () => ({ features: ['sign-in-rules'] }) as never };
    should(await new ProtocolRulesGateway(reported).features()).eql(['sign-in-rules']);
    const unreadable: RulesApiClient = {
      request: async () => {
        throw new Error('down');
      },
    };
    await should(new ProtocolRulesGateway(unreadable).features()).be.rejectedWith(DaemonFeaturesUnreadable);
  });

  it('should say an older daemon with no rule routes needs an update, on every route, and pass other errors on', async () => {
    const old: RulesApiClient = {
      request: async () => {
        throw new FyHttpError('no such route', 404, 'unknown_route');
      },
    };
    const gateway = new ProtocolRulesGateway(old);
    const sentence = daemonNeedsUpdate('standing sign-in rules');
    for (const call of [
      async () => await gateway.list(),
      async () => await gateway.narrow(RULE, { dropTotp: true }),
      async () => await gateway.revoke(RULE),
      async () => await gateway.revokeAccount('GITHUB_WORK'),
      async () => await gateway.stage({ signIn: SIGN_IN, fields: ['password'] }),
      async () => await gateway.eligibility(SIGN_IN),
    ])
      await should(call()).be.rejectedWith(sentence);

    const gone: RulesApiClient = {
      request: async () => {
        throw new FyHttpError('no such stage', 404, 'stage_not_found');
      },
    };
    await new ProtocolRulesGateway(gone).view(STAGE).then(
      () => should.fail('', '', 'a missing stage was answered'),
      (error: unknown) => should((error as FyHttpError).code).equal('stage_not_found'),
    );
  });
});
