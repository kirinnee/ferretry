import { describe, it } from 'bun:test';
import { defineEvent } from '@ferretry/kernel/contract';
import { definePlugin, tool } from '@ferretry/kernel/manifest';
import should from 'should';
import { z } from 'zod';
import { pluginClient, type SendOptions } from '../../src/lib/client.ts';
import { DaemonRefusal } from '../../src/lib/errors.ts';
import { PluginPausedError } from '../../src/lib/guard.ts';
import { PERSON_ONLY_REFUSAL } from '../../src/lib/credential.ts';
import { ToolClient } from '../../src/lib/tool-client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import {
  boardEntry,
  depsOf,
  FeedingTransport,
  inventoryOf,
  RecordingTransport,
  registryOf,
  skeletonEntry,
} from './fakes.ts';

const registry = registryOf(boardEntry());
const healthy = inventoryOf({ id: 'board', contract: 'h-board' });

describe('the guarded client', () => {
  it('should fill the route’s parameters and send once the plugin agrees', async () => {
    // Arrange
    const { deps, transport } = depsOf(registry, healthy);
    transport.replies.push({ status: 200, body: { id: 'c 1' } });

    // Act
    const answer = await pluginClient(deps, 'board').call('GET /v1/cards/:id', {
      params: { id: 'c 1' },
      query: { full: '1' },
    });

    // Assert
    should(answer).deepEqual({ id: 'c 1' });
    should(transport.sent).deepEqual([{ method: 'GET', path: '/v1/cards/c%201?full=1' }]);
  });

  it('should read the inventory again after a read failed, so one bad read is not held for ever', async () => {
    // Arrange
    let reads = 0;
    const { deps } = depsOf(registry, () => {
      reads += 1;
      if (reads === 1) throw new Error('daemon away');
      return healthy;
    });

    // Act
    const failed = await deps.inventory.current().then(
      () => undefined,
      (error: unknown) => error,
    );
    const recovered = await deps.inventory.current();

    // Assert
    should((failed as Error).message).equal('daemon away');
    should(recovered).equal(healthy);
    should(reads).equal(2);
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
    const { deps, transport } = depsOf(
      registry,
      inventoryOf({ id: 'board', on: false, contract: 'h-board' }, { id: 'caller', contract: 'c' }),
    );
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

  it('should say when no plugin declares the route', async () => {
    const { deps } = depsOf(registry, healthy);
    const client = pluginClient(deps, 'board');
    await should(client.call('GET /v1/nothing')).be.rejectedWith(/no plugin declares the route/u);
  });

  it('should refuse to subscribe over a transport that cannot hold a feed open, saying so', () => {
    const { deps } = depsOf(registry, healthy);
    const moved = defineEvent('board.moved', z.strictObject({ id: z.string() }));
    should(() => pluginClient(deps, 'board').subscribe(moved, () => undefined)).throw(/does not subscribe/u);
  });

  it('should open one feed for every listener, hand each event its payload, and close the feed with the last', async () => {
    const transport = new FeedingTransport();
    const { deps } = depsOf(registry, healthy, { transport });
    const moved = defineEvent('board.moved', z.strictObject({ id: z.string() }));
    const heard: string[] = [];
    const first = pluginClient(deps, 'board').subscribe(moved, payload => heard.push('a:' + payload.id));
    const second = pluginClient(deps, 'board').subscribe(moved, payload => heard.push('b:' + payload.id));
    await Bun.sleep(10);
    should(transport.opened).equal(1);
    transport.push('board.moved', { id: '1' });
    transport.push('board.moved', { id: 2 });
    await Bun.sleep(10);
    should(heard).deepEqual(['a:1', 'b:1']);
    first();
    should(transport.cancelled).equal(0);
    second();
    should(transport.cancelled).equal(1);
  });

  it('should drop the held inventory when the feed announces kernel.plugins-changed', async () => {
    const transport = new FeedingTransport();
    const { deps, reads } = depsOf(registry, healthy, { transport });
    await deps.inventory.current();
    pluginClient(deps, 'board').subscribe(defineEvent('board.moved', z.strictObject({})), () => undefined);
    await Bun.sleep(10);
    transport.push('kernel.plugins-changed', { generation: 2 });
    await deps.inventory.current();
    should(reads.count).equal(2);
  });

  it('§9.6 a subscription to a package that is off ends with the paused sentence and never opens the feed', async () => {
    // Arrange
    const transport = new FeedingTransport();
    const { deps, reads } = depsOf(registry, inventoryOf({ id: 'board', on: false, contract: 'h-board' }), {
      transport,
    });
    const moved = defineEvent('board.moved', z.strictObject({}));
    const ended: string[] = [];

    // Act
    const cancel = pluginClient(deps, 'board').follow(
      moved,
      () => undefined,
      reason => ended.push(reason),
    );
    await Bun.sleep(10);

    // Assert
    should(transport.opened).equal(0);
    should(ended.length).equal(1);
    should(ended[0]).match(/off/iu);
    should(reads.count).equal(2); // the one re-read before it was blocked
    cancel();
    should(transport.cancelled).equal(0);
  });

  it('§9.6 a subscription whose event owner is blocked is refused though the caller is allowed', async () => {
    const transport = new FeedingTransport();
    const { deps } = depsOf(
      registry,
      inventoryOf({ id: 'board', contract: 'h-board' }, { id: 'ferrets', on: false, contract: 'h-ferrets' }),
      {
        transport,
      },
    );
    const ended: string[] = [];
    pluginClient(deps, 'board').follow(
      defineEvent('ferrets.changed', z.strictObject({})),
      () => undefined,
      reason => ended.push(reason),
    );
    await Bun.sleep(10);
    should(transport.opened).equal(0);
    should(ended.length).equal(1);
  });

  it('§9.6 a daemon on another contract refuses the subscription with the restart sentence, feed unopened', async () => {
    const transport = new FeedingTransport();
    const { deps } = depsOf(registry, inventoryOf({ id: 'board', contract: 'other' }), { transport });
    const ended: string[] = [];
    pluginClient(deps, 'board').follow(
      defineEvent('board.moved', z.strictObject({})),
      () => undefined,
      reason => ended.push(reason),
    );
    await Bun.sleep(10);
    should(transport.opened).equal(0);
    should(ended.length).equal(1);
    should(ended[0]).not.equal('');
  });

  it('§9.6 a subscription cancelled before the check finishes never opens the feed', async () => {
    const transport = new FeedingTransport();
    const { deps } = depsOf(registry, healthy, { transport });
    const cancel = pluginClient(deps, 'board').subscribe(
      defineEvent('board.moved', z.strictObject({})),
      () => undefined,
    );
    cancel();
    await Bun.sleep(10);
    should(transport.opened).equal(0);
  });

  it('§9.6 a frame is dropped when the package went off since the check, with no inventory read per frame', async () => {
    // Arrange
    const transport = new FeedingTransport();
    let current = healthy;
    const { deps, reads } = depsOf(registry, () => current, { transport });
    const moved = defineEvent('board.moved', z.strictObject({ id: z.string() }));
    const heard: string[] = [];
    pluginClient(deps, 'board').subscribe(moved, payload => heard.push(payload.id));
    await Bun.sleep(10);
    transport.push('board.moved', { id: '1' });
    await Bun.sleep(10);
    const readsWhileOn = reads.count;

    // Act: the held inventory now says the package is off; the next frames are judged by it alone
    current = inventoryOf({ id: 'board', on: false, contract: 'h-board' });
    deps.inventory.invalidate();
    await deps.inventory.current();
    const readsBefore = reads.count;
    transport.push('board.moved', { id: '2' });
    transport.push('board.moved', { id: '3' });
    await Bun.sleep(10);

    // Assert
    should(heard).deepEqual(['1']);
    should(readsWhileOn).equal(1);
    should(reads.count).equal(readsBefore);
  });
});

const healthyDeps = () => depsOf(registry, healthy);

describe('the agent-tool client', () => {
  it('should send a tool call through the same guard, as a POST of the input', async () => {
    const { deps, transport } = depsOf(registry, healthy);
    await new ToolClient(deps).call('board', 'card_show', { id: 'a' });
    should(transport.sent).deepEqual([
      { method: 'POST', path: '/v1/agent/tools', body: { tool: 'card_show', input: { id: 'a' } } },
    ]);
  });

  it('S61 tool(name, input) on the plugin client takes the same road: guarded for the caller and the owner, one POST to the tool door', async () => {
    const { deps, transport } = depsOf(registry, healthy);
    await pluginClient(deps, 'board').tool('card_show', { id: 'a' });
    should(transport.sent).deepEqual([
      { method: 'POST', path: '/v1/agent/tools', body: { tool: 'card_show', input: { id: 'a' } } },
    ]);
    await pluginClient(deps, 'board').tool('card_show');
    should(transport.sent[1]).deepEqual({ method: 'POST', path: '/v1/agent/tools', body: { tool: 'card_show' } });
  });

  it('tool(name) is blocked unsent when the owner’s contract differs, refused in a pane when person-only, and when nobody declares it', async () => {
    const stale = depsOf(registry, inventoryOf({ id: 'board', contract: 'other' }));
    await should(pluginClient(stale.deps, 'board').tool('card_show', {})).be.rejectedWith(PluginPausedError);
    should(stale.transport.sent).deepEqual([]);
    const paned = depsOf(registry, healthy, { inPane: true });
    await should(pluginClient(paned.deps, 'board').tool('card_rules', {})).be.rejectedWith(PERSON_ONLY_REFUSAL);
    should(paned.transport.sent).deepEqual([]);
    should(paned.reads.count).equal(0);
    await should(pluginClient(healthyDeps().deps, 'board').tool('nope', {})).be.rejectedWith(
      /no plugin declares the tool/u,
    );
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

describe('the guard keeps up with the daemon (§9.6)', () => {
  it('should read the inventory again when the daemon restarted, and send nothing the new one blocks', async () => {
    // Arrange: the second call meets a daemon that came back as another process with Board off.
    let pid = '100';
    const { deps, transport, reads } = depsOf(
      registry,
      () => (pid === '100' ? healthy : inventoryOf({ id: 'board', on: false, contract: 'h-board' })),
      { instance: async () => pid },
    );
    const client = pluginClient(deps, 'board');
    await client.call('GET /v1/cards/:id', { params: { id: 'a' } });

    // Act
    pid = '200';
    const error = await client.call('GET /v1/cards/:id', { params: { id: 'b' } }).catch((failure: unknown) => failure);

    // Assert
    should(error).be.instanceOf(PluginPausedError);
    should(reads.count).be.above(1);
    should(transport.sent.length).equal(1);
  });

  it('should drop the held inventory when kernel.plugins-changed is heard, and judge the next call afresh', async () => {
    // Arrange
    let board = healthy;
    const { deps, transport, reads } = depsOf(registry, () => board);
    const client = pluginClient(deps, 'board');
    await client.call('GET /v1/cards/:id', { params: { id: 'a' } });

    // Act
    board = inventoryOf({ id: 'board', contract: 'another-build' });
    deps.inventory.heard('board.changed');
    const before = reads.count;
    deps.inventory.heard('kernel.plugins-changed');
    const error = await client.call('GET /v1/cards/:id', { params: { id: 'b' } }).catch((failure: unknown) => failure);

    // Assert
    should(before).equal(1);
    should(error).be.instanceOf(PluginPausedError);
    should(transport.sent.length).equal(1);
  });

  it('should hand the transport a recheck that re-reads the inventory and refuses the resend after a restart', async () => {
    // Arrange: a transport that, like one riding out a restart, asks the recheck before sending again.
    let board = healthy;
    const rechecked: string[] = [];
    const transport = new (class extends RecordingTransport {
      override async send(request: DaemonRequest, options?: SendOptions) {
        board = inventoryOf({ id: 'board', on: false, contract: 'h-board' });
        try {
          await options?.recheck?.();
        } catch (error) {
          rechecked.push((error as Error).name);
          throw error;
        }
        return await super.send(request);
      }
    })();
    const { deps, reads } = depsOf(registry, () => board, { transport });

    // Act
    const error = await pluginClient(deps, 'board')
      .call('GET /v1/cards/:id', { params: { id: 'a' } })
      .catch((failure: unknown) => failure);

    // Assert
    should(error).be.instanceOf(PluginPausedError);
    should(rechecked).deepEqual(['PluginPausedError']);
    should(reads.count).equal(3);
    should(transport.sent).deepEqual([]);
  });

  it('should block every plugin, unsent, when a core package differs, whatever the plugin’s own hash', async () => {
    // Arrange: Board matches; Gate is another build.
    const { deps, transport } = depsOf(
      registry,
      inventoryOf({ id: 'gate', contract: 'other-gate' }, { id: 'board', contract: 'h-board' }),
    );

    // Act
    const error = await pluginClient(deps, 'board')
      .call('GET /v1/cards/:id', { params: { id: 'a' } })
      .catch((failure: unknown) => failure);

    // Assert
    should(error).be.instanceOf(PluginPausedError);
    should((error as PluginPausedError).reason).equal('core');
    should((error as PluginPausedError).plugin).equal('gate');
    should((error as Error).message).containEql('Gate, which everything needs');
    should(transport.sent).deepEqual([]);
  });

  it('should send a Kernel route only once the Kernel’s own hash matches', async () => {
    const blocked = depsOf(
      registry,
      inventoryOf({ id: 'kernel', contract: 'old-kernel' }, { id: 'board', contract: 'h-board' }),
    );
    await should(pluginClient(blocked.deps, 'kernel').call('GET /v1/glossary')).be.rejectedWith(PluginPausedError);
    should(blocked.transport.sent).deepEqual([]);

    const allowed = depsOf(registry, healthy);
    await pluginClient(allowed.deps, 'kernel').call('GET /v1/glossary');
    should(allowed.transport.sent).deepEqual([{ method: 'GET', path: '/v1/glossary' }]);
  });
});

describe('a call whose caller may stop waiting', () => {
  it('G95 hands the caller’s signal to the transport, so the send in flight can be cancelled', async () => {
    const { deps, transport } = depsOf(registry, healthy);
    const caller = new AbortController();

    await pluginClient(deps, 'board').call('GET /v1/cards/:id', { params: { id: 'c1' }, signal: caller.signal });

    should(transport.options[0]?.signal).equal(caller.signal);
    // The signal is the transport's, never a part of the request the daemon is sent.
    should(transport.sent).deepEqual([{ method: 'GET', path: '/v1/cards/c1' }]);
  });

  it('G95 a call whose caller already stopped waiting sends nothing and ends with the signal’s reason', async () => {
    const { deps, transport } = depsOf(registry, healthy);
    const caller = new AbortController();
    caller.abort(new Error('gave up'));

    const error = await pluginClient(deps, 'board')
      .call('GET /v1/cards/:id', { params: { id: 'c1' }, signal: caller.signal })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    should((error as Error).message).equal('gave up');
    should(transport.sent).deepEqual([]);
  });

  it('G95 a call with no signal sends none, and an abort after the answer changes nothing', async () => {
    const { deps, transport } = depsOf(registry, healthy);
    await pluginClient(deps, 'board').call('GET /v1/cards/:id', { params: { id: 'c1' } });
    should(transport.options[0]?.signal).equal(undefined);

    const caller = new AbortController();
    transport.replies.push({ status: 200, body: { id: 'c2' } });
    const answer = await pluginClient(deps, 'board').call('GET /v1/cards/:id', {
      params: { id: 'c2' },
      signal: caller.signal,
    });
    caller.abort();
    should(answer).deepEqual({ id: 'c2' });
  });
});

describe('a tool declared twice, and a feed that fails', () => {
  const twin = definePlugin({
    id: 'twin',
    title: 'Twin',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: {
      agentTools: [
        tool('card_show', {
          minimum: 'authenticated',
          audit: { skip: 'test' },
          guard: { none: 'test' },
          caller: 'any',
        }),
      ],
    },
  });

  it('refuses a tool name that more than one plugin declares, before anything is contacted', async () => {
    const { deps, transport, reads } = depsOf(registryOf(boardEntry(), skeletonEntry(twin)), healthy);
    await should(pluginClient(deps, 'board').tool('card_show', {})).be.rejectedWith(
      /more than one plugin declares the tool card_show/u,
    );
    should(transport.sent).deepEqual([]);
    should(reads.count).equal(0);
  });

  it('ends every follower with the reason when the daemon closes the feed, and opens a new feed for the next follower', async () => {
    // Arrange
    const transport = new FeedingTransport();
    const { deps } = depsOf(registry, healthy, { transport });
    const moved = defineEvent('board.moved', z.strictObject({}));
    const ended: string[] = [];
    pluginClient(deps, 'board').follow(
      moved,
      () => undefined,
      reason => ended.push('a:' + reason),
    );
    pluginClient(deps, 'board').follow(
      moved,
      () => undefined,
      reason => ended.push('b:' + reason),
    );
    await Bun.sleep(10);

    // Act
    transport.close('daemon went away');
    await Bun.sleep(10);
    pluginClient(deps, 'board').follow(
      moved,
      () => undefined,
      () => undefined,
    );
    await Bun.sleep(10);

    // Assert
    should(ended).deepEqual(['a:daemon went away', 'b:daemon went away']);
    should(transport.opened).equal(2);
  });

  it('ends the follow with the transport’s own words when it fails to open the feed', async () => {
    // Arrange
    const transport = new (class extends FeedingTransport {
      override events(): () => void {
        throw new Error('feed refused');
      }
    })();
    const { deps } = depsOf(registry, healthy, { transport });
    const ended: string[] = [];

    // Act
    pluginClient(deps, 'board').follow(
      defineEvent('board.moved', z.strictObject({})),
      () => undefined,
      reason => ended.push(reason),
    );
    await Bun.sleep(10);

    // Assert
    should(ended).deepEqual(['feed refused']);
  });
});
