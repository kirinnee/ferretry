import { describe, it } from 'bun:test';
import should from 'should';
import { ProtocolRulesGateway } from '../../../src/lib/rules/gateway';
import type { RulesApiClient } from '../../../src/lib/rules/ports';

const STAGE = `srs_${'a'.repeat(24)}`;
const SIGN_IN = `si_${'1'.repeat(16)}`;

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
});
