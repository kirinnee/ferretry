import { describe, it } from 'bun:test';
import should from 'should';
import { ProtocolRulesGateway } from '../../../../cli/lib/rules/gateway';
import manifest from '../../../../manifest.ts';

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

type Init = { readonly params?: Record<string, string>; readonly query?: Record<string, string>; readonly body?: unknown };

function rig(reply: unknown) {
  const calls: { route: string; init: Init | undefined }[] = [];
  const client = {
    call: async <Answer>(route: string, init?: Init): Promise<Answer> => {
      calls.push({ route, init });
      return reply as Answer;
    },
  };
  return { calls, gateway: new ProtocolRulesGateway(client) };
}

const declared = new Set(manifest.actions.routes.map(route => route.key as string));

describe('ProtocolRulesGateway', () => {
  it('S132 should offer no commit call and no way to name the commit route', () => {
    const names = Object.getOwnPropertyNames(ProtocolRulesGateway.prototype);
    should(names.filter(name => /commit|approve/iu.test(name))).eql([]);
  });

  it('should call only routes the manifest declares, by key, through the plugin client', async () => {
    const { calls, gateway } = rig({ health: 'ok', rules: [], stages: [] });
    await gateway.list();
    await gateway.view(STAGE).catch(() => undefined);
    await gateway.confirmInApp(STAGE).catch(() => undefined);
    await gateway.drop(STAGE).catch(() => undefined);
    await gateway.revoke(RULE).catch(() => undefined);
    await gateway.revokeAccount('GITHUB_WORK').catch(() => undefined);
    await gateway.eligibility(SIGN_IN).catch(() => undefined);
    await gateway.narrow(RULE, { dropTotp: true }).catch(() => undefined);
    await gateway.stage({ signIn: SIGN_IN, fields: ['password'] }).catch(() => undefined);
    should(calls.map(call => call.route).filter(route => !declared.has(route))).eql([]);
    should(calls.map(call => call.route)).not.containEql('POST /v1/sign-in-rules/stages/:stage/commit');
    should(calls[1]?.init?.params).eql({ stage: STAGE });
    should(calls[6]?.init?.query).eql({ signIn: SIGN_IN });
  });

  it('should refuse a draft the protocol would refuse, before sending it', async () => {
    const { calls, gateway } = rig({});
    await gateway.stage({ signIn: SIGN_IN, fields: ['password'], totp: true }).then(
      () => should.fail('', '', 'sent an unacknowledged code'),
      () => undefined,
    );
    should(calls).eql([]);
  });

  it('should stage the parsed draft and parse what comes back', async () => {
    const { calls, gateway } = rig(STAGED);
    should(await gateway.stage({ signIn: SIGN_IN, fields: ['password'] })).match({ stage: STAGE, rule: RULE });
    should(calls[0]).match({ route: 'POST /v1/sign-in-rules/stages', init: { body: { signIn: SIGN_IN } } });
    await should(rig({ stage: 'nope' }).gateway.stage({ signIn: SIGN_IN, fields: ['password'] })).be.rejected();
  });

  it('should narrow by rule id and refuse an empty narrowing before sending it', async () => {
    const { calls, gateway } = rig(RULE_VIEW);
    await gateway.narrow(RULE, { dropTotp: true });
    should(calls[0]).match({ route: 'POST /v1/sign-in-rules/:id/narrow', init: { params: { id: RULE } } });
    should(calls[0]?.init?.body).eql({ dropTotp: true });
    await gateway.narrow(RULE, {}).then(
      () => should.fail('', '', 'sent an empty narrowing'),
      () => undefined,
    );
    should(calls).have.length(1);
  });

  it('should answer how many rules an account revoke ended', async () => {
    const { gateway } = rig({ account: 'GITHUB_WORK', revoked: 3 });
    should(await gateway.revokeAccount('GITHUB_WORK')).equal(3);
  });
});
