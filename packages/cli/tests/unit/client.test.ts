import { describe, it } from 'bun:test';
import should from 'should';
import { pluginClient } from '../../src/lib/client.ts';
import { DaemonRefusal } from '../../src/lib/errors.ts';
import { PluginPausedError } from '../../src/lib/guard.ts';
import { PERSON_ONLY_REFUSAL } from '../../src/lib/credential.ts';
import { ToolClient, toolPath } from '../../src/lib/tool-client.ts';
import { boardEntry, depsOf, inventoryOf, registryOf } from './fakes.ts';

const registry = registryOf(boardEntry());
const healthy = inventoryOf({ id: 'board', contract: 'h-board' });

describe('the guarded client', () => {
  it('should fill the route’s parameters and send once the plugin agrees', async () => {
    // Arrange
    const { deps, transport } = depsOf(registry, healthy);
    transport.replies.push({ status: 200, body: { id: 'c 1' } });

    // Act
    const answer = await pluginClient(deps, 'board').call('GET /v1/cards/:id', { params: { id: 'c 1' }, query: { full: '1' } });

    // Assert
    should(answer).deepEqual({ id: 'c 1' });
    should(transport.sent).deepEqual([{ method: 'GET', path: '/v1/cards/c%201?full=1' }]);
  });

  it('should read the inventory once for any number of calls', async () => {
    const { deps, reads } = depsOf(registry, healthy);
    const client = pluginClient(deps, 'board');
    await client.call('GET /v1/cards/:id', { params: { id: 'a' } });
    await client.call('GET /v1/cards/:id', { params: { id: 'b' } });
    should(reads.count).equal(1);
  });

  for (const [name, inventory] of [
    ['has another contract hash', inventoryOf({ id: 'board', contract: 'other' })],
    ['is off', inventoryOf({ id: 'board', on: false, contract: 'h-board' })],
    ['is missing', inventoryOf()],
  ] as const)
    it(`should block a call without sending it when the plugin ${name} (plugin_paused)`, async () => {
      // Arrange
      const { deps, transport } = depsOf(registry, inventory);

      // Act
      const error = await pluginClient(deps, 'board')
        .call('GET /v1/cards/:id', { params: { id: 'a' } })
        .catch((failure: unknown) => failure);

      // Assert
      should(error).be.instanceOf(PluginPausedError);
      should((error as PluginPausedError).code).equal('plugin_paused');
      should((error as PluginPausedError).exitCode).equal(69);
      should(transport.sent).deepEqual([]);
    });

  it('should re-read the inventory once before blocking, so a daemon restarted on a new build is not judged by its old one', async () => {
    // Arrange
    let reads = 0;
    const { deps, transport } = depsOf(registry, () => {
      reads += 1;
      return reads === 1 ? inventoryOf({ id: 'board', contract: 'old' }) : healthy;
    });

    // Act
    await pluginClient(deps, 'board').call('GET /v1/cards/:id', { params: { id: 'a' } });

    // Assert
    should(reads).equal(2);
    should(transport.sent.length).equal(1);
  });

  it('should also check the owner of a route it consumes from another plugin', async () => {
    // Arrange: a caller plugin that is healthy calls a board route while board is off.
    const { deps, transport } = depsOf(registry, inventoryOf({ id: 'board', on: false, contract: 'h-board' }, { id: 'caller', contract: 'c' }));
    (deps.surfaces.compiled as Record<string, string>).caller = 'c';

    // Act
    const error = await pluginClient(deps, 'caller')
      .call('GET /v1/cards/:id', { params: { id: 'a' } })
      .catch((failure: unknown) => failure);

    // Assert
    should(error).be.instanceOf(PluginPausedError);
    should((error as PluginPausedError).plugin).equal('board');
    should(transport.sent).deepEqual([]);
  });

  it('S54 a refusal is final: the status and the daemon’s sentence are the answer, with no second send', async () => {
    // Arrange
    const { deps, transport } = depsOf(registry, healthy);
    transport.replies.push({ status: 403, body: { error: 'this is the owner’s command', code: 'owner_only' } });

    // Act
    const error = await pluginClient(deps, 'board')
      .call('GET /v1/cards/:id', { params: { id: 'a' } })
      .catch((failure: unknown) => failure);

    // Assert
    should(error).be.instanceOf(DaemonRefusal);
    should((error as DaemonRefusal).status).equal(403);
    should((error as DaemonRefusal).code).equal('owner_only');
    should(transport.sent.length).equal(1);
  });

  it('S59 a person route is refused in a pane before the daemon is contacted, inventory read included', async () => {
    // Arrange
    const { deps, transport, reads } = depsOf(registry, healthy, { inPane: true });

    // Act
    const error = await pluginClient(deps, 'board')
      .call('POST /v1/cards/:id/move', { params: { id: 'a' }, body: { to: 'done' } })
      .catch((failure: unknown) => failure);

    // Assert
    should((error as Error).message).equal(PERSON_ONLY_REFUSAL);
    should(transport.sent).deepEqual([]);
    should(reads.count).equal(0);
  });

  it('S61 every caller:person route refuses a ferret, while an open route still works in the same pane', async () => {
    const { deps, transport } = depsOf(registry, healthy, { inPane: true });
    const client = pluginClient(deps, 'board');
    await client.call('GET /v1/cards/:id', { params: { id: 'a' } });
    await should(client.call('POST /v1/cards/:id/move', { params: { id: 'a' } })).be.rejectedWith(PERSON_ONLY_REFUSAL);
    should(transport.sent.length).equal(1);
  });

  it('should say when no plugin declares the route, and never subscribe', async () => {
    const { deps } = depsOf(registry, healthy);
    const client = pluginClient(deps, 'board');
    await should(client.call('GET /v1/nothing')).be.rejectedWith(/no plugin declares the route/u);
    should(() => client.subscribe({} as never, () => undefined)).throw(/does not subscribe/u);
  });
});

describe('the agent-tool client', () => {
  it('should send a tool call through the same guard, as a POST of the input', async () => {
    const { deps, transport } = depsOf(registry, healthy);
    await new ToolClient(deps).call('board', 'card_show', { id: 'a' });
    should(transport.sent).deepEqual([{ method: 'POST', path: toolPath('board', 'card_show'), body: { id: 'a' } }]);
  });

  it('should block a tool of a plugin the daemon does not agree on, unsent', async () => {
    const { deps, transport } = depsOf(registry, inventoryOf({ id: 'board', contract: 'other' }));
    await should(new ToolClient(deps).call('board', 'card_show', {})).be.rejectedWith(PluginPausedError);
    should(transport.sent).deepEqual([]);
  });

  it('S61 should refuse a person-only tool in a pane before contacting the daemon', async () => {
    const { deps, transport, reads } = depsOf(registry, healthy, { inPane: true });
    await should(new ToolClient(deps).call('board', 'card_rules', {})).be.rejectedWith(PERSON_ONLY_REFUSAL);
    should(transport.sent).deepEqual([]);
    should(reads.count).equal(0);
  });

  it('should refuse a tool nobody declares', async () => {
    const { deps } = depsOf(registry, healthy);
    await should(new ToolClient(deps).call('board', 'nope', {})).be.rejectedWith(/declares no tool/u);
  });
});
