import { describe, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { GRANTS_ROUTE } from '../../../cli/lib/authority.ts';
import { BUDGETS_ROUTE, ClientLoginsGateway, ROUTES } from '../../../cli/lib/gateway.ts';
import { AT, flow, login, loginList } from './fakes.ts';

interface Recorded {
  readonly route: string;
  readonly init: unknown;
}

/** A client that answers each route with a fixed value and records what it was asked. */
function gatewayAnswering(answers: Readonly<Record<string, unknown>>) {
  const calls: Recorded[] = [];
  const client: PluginClient = {
    call: async <Answer>(route: string, init?: unknown): Promise<Answer> => {
      calls.push({ route, init });
      if (!(route in answers)) throw new Error(`no answer for ${route}`);
      return answers[route] as Answer;
    },
    subscribe: () => () => undefined,
  };
  return { gateway: new ClientLoginsGateway(client), calls };
}

const TEST_RESULT = { loginId: 'glm', ok: true, code: 'ok', message: 'Works.', spent: 'nothing', at: AT };
const CHANGE_VIEW = {
  id: 'chg1',
  change: { kind: 'login.enable', id: 'work' },
  summary: 'Enable work',
  consequences: [],
  expiresAt: AT,
  state: 'pending',
};

describe('ClientLoginsGateway — each call goes to its own route, with a body the contract accepts', () => {
  it('checks one login with an empty body', async () => {
    const { gateway, calls } = gatewayAnswering({ [ROUTES.check]: login() });
    should((await gateway.check('claude-you')).id).equal('claude-you');
    should(calls).eql([
      { route: ROUTES.check, init: { params: { loginId: 'claude-you' }, body: {} } },
      { route: BUDGETS_ROUTE, init: undefined },
    ]);
  });

  it('puts a budgeted login’s standing from Usage on its row, in the list and after a check', async () => {
    const budget = { timeZone: 'UTC', timeZoneSet: true, level: 'ok', unpriced: 0, measured: true };
    const { gateway } = gatewayAnswering({
      [ROUTES.logins]: loginList(login({ id: 'claude-you' }), login({ id: 'other' })),
      [ROUTES.check]: login({ id: 'claude-you' }),
      [BUDGETS_ROUTE]: { budgets: [{ login: 'claude-you', budget }] },
    });
    const list = await gateway.logins();
    should(list.logins.map(row => row.budget)).eql([budget, undefined]);
    should((await gateway.check('claude-you')).budget).eql(budget);
  });

  it('shows no budget, and no error, when Usage cannot say', async () => {
    const refused = gatewayAnswering({
      [ROUTES.logins]: loginList(login({ id: 'claude-you' })),
    });
    should((await refused.gateway.logins()).logins[0]?.budget).be.undefined();
    const unreadable = gatewayAnswering({
      [ROUTES.logins]: loginList(login({ id: 'claude-you' })),
      [BUDGETS_ROUTE]: { budgets: 'nonsense' },
    });
    should((await unreadable.gateway.logins()).logins[0]?.budget).be.undefined();
  });

  it('tests a login, sending the consent only when it is given', async () => {
    const { gateway, calls } = gatewayAnswering({ [ROUTES.test]: TEST_RESULT });
    should((await gateway.test('glm', false)).ok).be.true();
    await gateway.test('glm', true);
    should(calls.map(call => call.init)).eql([
      { params: { loginId: 'glm' }, body: {} },
      { params: { loginId: 'glm' }, body: { allowInference: true } },
    ]);
  });

  it('reads the presets, the model catalogs and a catalog refresh', async () => {
    const { gateway, calls } = gatewayAnswering({
      [ROUTES.presets]: { presets: [] },
      [ROUTES.models]: { published: { origin: 'https://x.example.test', enabled: false }, catalogs: [] },
      [ROUTES.refreshModels]: { outcome: 'disabled' },
    });
    should(await gateway.presets()).eql({ presets: [] });
    should((await gateway.models()).published.enabled).be.false();
    should(await gateway.refreshModels()).eql({ outcome: 'disabled' });
    should(calls.map(call => call.route)).eql([ROUTES.presets, ROUTES.models, ROUTES.refreshModels]);
  });

  it('starts a sign-in, naming a method and a restart only when asked', async () => {
    const { gateway, calls } = gatewayAnswering({ [ROUTES.signInStart]: flow() });
    await gateway.startSignIn('claude-you');
    await gateway.startSignIn('codex-you', 'link', true);
    should(calls.map(call => call.init)).eql([
      { body: { loginId: 'claude-you' } },
      { body: { loginId: 'codex-you', method: 'link', restart: true } },
    ]);
  });

  it('reads, submits to, rechecks and cancels a sign-in by its flow id', async () => {
    const accepted = { outcome: 'accepted', flow: flow({ state: 'complete' }) };
    const { gateway, calls } = gatewayAnswering({
      [ROUTES.signInStatus]: flow(),
      [ROUTES.signInSubmit]: accepted,
      [ROUTES.signInCancel]: flow({ state: 'failed', reason: 'stopped', remedy: 'again' }),
    });
    should((await gateway.signInStatus('flow-1')).flowId).equal('flow-1');
    should((await gateway.submitSignInCode('flow-1', 'PASTED#state')).outcome).equal('accepted');
    should((await gateway.recheckSignIn('flow-1')).outcome).equal('accepted');
    should((await gateway.cancelSignIn('flow-1')).state).equal('failed');
    should(calls).eql([
      { route: ROUTES.signInStatus, init: { params: { flowId: 'flow-1' } } },
      { route: ROUTES.signInSubmit, init: { params: { flowId: 'flow-1' }, body: { code: 'PASTED#state' } } },
      { route: ROUTES.signInSubmit, init: { params: { flowId: 'flow-1' }, body: { method: 'recheck' } } },
      { route: ROUTES.signInCancel, init: { params: { flowId: 'flow-1' } } },
    ]);
  });

  it('reads the caller’s authority from the grants, and the stricter reading when it cannot tell', async () => {
    const open = gatewayAnswering({
      [GRANTS_ROUTE]: {
        capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }],
      },
    });
    should(await open.gateway.authority()).eql({ mayApply: true, applyRefusal: 'granted' });
    const unreadable = gatewayAnswering({ [GRANTS_ROUTE]: 'nonsense' });
    should(await unreadable.gateway.authority()).eql({ mayApply: false, applyRefusal: 'undetermined' });
  });

  it('stages a change and applies it by the id the daemon gave', async () => {
    const { gateway, calls } = gatewayAnswering({
      [ROUTES.stage]: CHANGE_VIEW,
      [ROUTES.apply]: { outcome: 'applied' },
    });
    const staged = await gateway.stage({ kind: 'login.enable', id: 'work' });
    should(await gateway.apply(staged.id)).eql({ outcome: 'applied' });
    should(calls).eql([
      { route: ROUTES.stage, init: { body: { kind: 'login.enable', id: 'work' } } },
      { route: ROUTES.apply, init: { params: { changeId: 'chg1' } } },
    ]);
  });

  it('refuses a change this build’s contract does not know, before anything is sent', async () => {
    const { gateway, calls } = gatewayAnswering({});
    await should(gateway.stage({ kind: 'login.nonesuch' } as never)).be.rejected();
    should(calls).be.empty();
  });

  it('refuses an answer that carries a field the contract does not name', async () => {
    const { gateway } = gatewayAnswering({ [ROUTES.apply]: { outcome: 'applied', accessToken: 'x' } });
    await should(gateway.apply('chg1')).be.rejected();
  });
});
