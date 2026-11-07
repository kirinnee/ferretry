import { describe, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { ClientRuntimesGateway, ROUTES } from '../../../../cli/lib/fleet/account-gateway.ts';
import manifest from '../../../../manifest.ts';
import { CHANGE_ID, changeView, committed, machine, recommendation, scan } from './account-fakes.ts';

interface Sent {
  readonly route: string;
  readonly init: Parameters<PluginClient['call']>[1];
}

/** A client that answers each route key with a canned body. */
function client(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fake: PluginClient = {
    call: async <Answer>(route: string, init?: Parameters<PluginClient['call']>[1]): Promise<Answer> => {
      sent.push({ route, init });
      if (!(route in answers)) throw new Error(`no answer for ${route}`);
      return answers[route] as Answer;
    },
    subscribe: () => () => undefined,
  };
  return { sent, fake };
}

describe('ClientRuntimesGateway', () => {
  it('should only call route keys the manifest declares', () => {
    const declared = new Set(manifest.actions.routes.map(route => route.key));
    for (const key of Object.values(ROUTES)) should(declared.has(key)).be.true();
  });

  it('should read the catalogue routes', async () => {
    // Arrange
    const { sent, fake } = client({
      [ROUTES.machine]: machine(),
      [ROUTES.components]: { format: 'present', kinds: [] },
      [ROUTES.profiles]: { format: 'present', profiles: [] },
      [ROUTES.runtimes]: { format: 'present', runtimes: [] },
    });
    const gateway = new ClientRuntimesGateway(fake);

    // Act
    await gateway.machine();
    await gateway.components();
    await gateway.profiles();
    await gateway.runtimes();

    // Assert
    should(sent.map(call => call.route)).eql([
      'GET /v1/runtimes/machine',
      'GET /v1/runtimes/components',
      'GET /v1/runtimes/profiles',
      'GET /v1/runtimes',
    ]);
  });

  it('should stage one change and apply exactly the proposal it was given', async () => {
    // Arrange
    const change = { kind: 'runtime.remove', name: 'old' } as const;
    const { sent, fake } = client({
      [ROUTES.propose]: changeView(change),
      [ROUTES.apply]: committed(),
    });
    const gateway = new ClientRuntimesGateway(fake);

    // Act
    const view = await gateway.stage(change);
    await gateway.apply(CHANGE_ID);

    // Assert
    should(view.id).equal(CHANGE_ID);
    should(sent[0]?.init?.body).eql({ change });
    should(sent[1]?.init?.params).eql({ proposalId: CHANGE_ID });
    should(sent[1]?.init?.body).eql({});
  });

  it('should read the first-run scan', async () => {
    const { sent, fake } = client({ [ROUTES.scan]: scan() });
    const actual = await new ClientRuntimesGateway(fake).scan();
    should(sent[0]?.route).equal('GET /v1/runtimes/setup/scan');
    should(actual.machine).equal('studio');
  });

  it('should post the task and read the guide back', async () => {
    // Arrange
    const { sent, fake } = client({ [ROUTES.recommend]: recommendation() });

    // Act
    const actual = await new ClientRuntimesGateway(fake).recommend({ task: 'port the CLI groups', usage: true });

    // Assert
    should(sent[0]?.route).equal('POST /v1/recommend');
    should(sent[0]?.init?.body).eql({ task: 'port the CLI groups', usage: true });
    should(actual.roles[0]?.primary.agent).equal('codex');
  });

  it('should refuse an empty task before it reaches the daemon', async () => {
    const { sent, fake } = client({ [ROUTES.recommend]: recommendation() });
    await should(new ClientRuntimesGateway(fake).recommend({ task: '', usage: true })).be.rejected();
    should(sent).be.empty();
  });

  it('should refuse a change the route would refuse, before sending it', async () => {
    const { sent, fake } = client({});
    await should(
      new ClientRuntimesGateway(fake).stage({ kind: 'profile.put', name: 'p', layers: [], create: true }),
    ).be.rejected();
    should(sent).be.empty();
  });

  it('should fail loudly when the daemon answers with something that is not the shape it promised', async () => {
    const { fake } = client({ [ROUTES.recommend]: { error: 'no routing catalog' }, [ROUTES.machine]: { name: 'x' } });
    const gateway = new ClientRuntimesGateway(fake);
    await should(gateway.recommend({ task: 'anything', usage: false })).be.rejected();
    await should(gateway.machine()).be.rejected();
  });
});
