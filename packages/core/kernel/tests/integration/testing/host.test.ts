import { describe, expect, test } from 'bun:test';
import { seconds } from '@ferretry/std';
import { z } from 'zod';
import type { TargetKind, TargetRef } from '../../../contract/act.ts';
import { defineEvent, defineState } from '../../../contract/define.ts';
import { jsonResponse } from '../../../contract/http.ts';
import type { CarrierKey } from '../../../contract/ids.ts';
import { policyRef } from '../../../contract/policy.ts';
import { type Carrier, type CarrierLink, isSessionEnd, type SessionLayer } from '../../../contract/session.ts';
import { definePlugin, implementDaemon, route, skeletonDaemon, tool } from '../../../manifest/index.ts';
import {
  type CarrierPeer,
  SimulatedCrash,
  carrierConformance,
  device,
  ferret,
  fixedClock,
  owner,
  testHost,
  toolConformance,
} from '../../../testing/index.ts';

const scoped = { minimum: 'authenticated', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const Items = defineState({
  name: 'items',
  path: 'items.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ names: z.array(z.string()) }),
});
const ItemAdded = defineEvent('demo.item-added', z.strictObject({ name: z.string() }));
const pane = (key: string): TargetRef => ({ kind: 'pane' as TargetKind, key });

const demoManifest = definePlugin({
  id: 'demo',
  title: 'Demo',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['tool'],
  actions: {
    routes: [
      route('GET /v1/demo/items', scoped),
      route('POST /v1/demo/items', { ...scoped, caller: 'person' }),
      route('GET /v1/demo/secret', { ...scoped, guard: 'secrets' }),
      route('GET /v1/demo/terminal', {
        ...scoped,
        capability: { capability: policyRef('capability', 'terminal'), axis: 'use' },
      }),
    ],
    agentTools: [tool('demo_send', { ...scoped, op: 'keys' }), tool('demo_read', { ...scoped, op: 'read' })],
  },
  data: { state: [Items], publishes: [ItemAdded], subscribes: [ItemAdded] },
});

let release: () => void = () => {};
const heard: string[] = [];

const demo = implementDaemon(demoManifest, {
  build: ({ kernel }) => ({
    routes: {
      'GET /v1/demo/items': async () => {
        const read = await kernel.state.read(Items);
        return jsonResponse(read.ok ? (read.value ?? { names: [] }) : { damaged: read.error.reason });
      },
      'POST /v1/demo/items': async ({ request }) => {
        const { name } = JSON.parse(await request.text()) as { name: string };
        await kernel.state.update(Items, current => ({ names: [...(current?.names ?? []), name] }));
        kernel.events.publish(ItemAdded, { name });
        return jsonResponse({ ok: true }, 201);
      },
      'GET /v1/demo/secret': async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return jsonResponse({ text: 'masked already' });
      },
      'GET /v1/demo/terminal': async () => jsonResponse({ ok: true }),
    },
    tools: {
      demo_send: async (_call, input) => {
        const { pane: key, raw } = input as { pane: string; raw?: unknown };
        const result = await kernel.act(pane(key), 'keys', async () => (raw ?? { status: 'done' }) as never);
        return result.ok
          ? { text: 'sent', data: result.value as never }
          : { text: result.error.refused, isError: true };
      },
      demo_read: async (_call, input) => {
        const { pane: key } = input as { pane: string };
        const result = await kernel.act(pane(key), 'read', async () => ({
          kind: 'content',
          text: await kernel.redaction.read(scope => scope.text('token hunter2')),
        }));
        return result.ok ? { text: result.value.text ?? '' } : { text: result.error.refused, isError: true };
      },
    },
    subscribers: {
      'demo.item-added': payload => {
        heard.push(payload.name);
      },
    },
  }),
});

const skeleton = skeletonDaemon(
  definePlugin({
    id: 'later',
    title: 'Later',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: { routes: [route('GET /v1/later', scoped)] },
  }),
);

describe('test host', () => {
  test('routes by the real table, admits through the stand-in, stores with formats, delivers events', async () => {
    const host = await testHost({ plugins: [demo, skeleton], clock: fixedClock('2026-11-06T09:00:00.000Z') });
    expect((await host.request('POST', '/v1/demo/items', { body: { name: 'a' } })).status).toBe(201);
    expect((await host.request('GET', '/v1/demo/items')).json()).toEqual({ names: ['a'] });
    expect(host.state('demo').raw(Items)).toBe('{"format":1,"names":["a"]}');
    await host.settle();
    expect(heard).toContain('a');
    expect(host.published).toEqual([{ event: 'demo.item-added', payload: { name: 'a' } }]);
    expect((await host.request('GET', '/v1/nothing')).status).toBe(404);
    expect((await host.request('DELETE', '/v1/demo/items')).status).toBe(405);
  });

  test('a skeleton answers 503 plugin_unavailable with its sentence', async () => {
    const host = await testHost({ plugins: [skeleton] });
    const answer = await host.request('GET', '/v1/later');
    expect(answer.status).toBe(503);
    expect(answer.json()).toEqual({
      error: 'Later is not built yet in this version of Ferretry.',
      code: 'plugin_unavailable',
    });
  });

  test('the stand-in refuses a ferret on a person route and a device without the capability', async () => {
    const host = await testHost({ plugins: [demo] });
    const refused = await host.request('POST', '/v1/demo/items', { body: { name: 'x' }, as: ferret('F1') });
    expect(refused.status).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('owner_only');
    expect((await host.request('GET', '/v1/demo/terminal', { as: device('phone', ['fleet.use']) })).status).toBe(403);
    expect((await host.request('GET', '/v1/demo/terminal', { as: device('phone', ['terminal.use']) })).status).toBe(
      200,
    );
    expect((await host.request('GET', '/v1/demo/items', { as: { kind: 'anonymous' } })).status).toBe(401);
  });

  test('a damaged file reads as damaged, never as empty', async () => {
    const host = await testHost({ plugins: [demo] });
    host.state('demo').plant(Items, '{"format":2,"names":[]}');
    expect((await host.request('GET', '/v1/demo/items')).json()).toEqual({ damaged: 'higher_format' });
    expect(host.state('demo').port([Items]).damaged()[0]?.reason).toBe('higher_format');
  });

  test('crashAfterNextWrite: the write lands, the process dies, a restart sees it', async () => {
    const host = await testHost({ plugins: [demo] });
    host.crashAfterNextWrite();
    await expect(host.request('POST', '/v1/demo/items', { body: { name: 'kept' } })).rejects.toBeInstanceOf(
      SimulatedCrash,
    );
    const again = await host.restart();
    expect((await again.request('GET', '/v1/demo/items')).json()).toEqual({ names: ['kept'] });
  });

  test("a guarded body is withheld when a hold began while it was being built (the final check, 'late')", async () => {
    const host = await testHost({ plugins: [demo] });
    const pending = host.request('GET', '/v1/demo/secret', { as: owner() });
    await Promise.resolve();
    host.holdBegins();
    release();
    const answer = await pending;
    expect(answer.status).toBe(409);
    expect(answer.json<{ code: string }>().code).toBe('withheld');
  });

  test('kernel.act: holds refuse before the act, a write-only result passes closeAck, reads are masked', async () => {
    const host = await testHost({ plugins: [demo], secrets: ['hunter2'] });
    expect((await host.tool('demo_send', { pane: 'p1' })).data).toEqual({ status: 'done' });
    expect((await host.tool('demo_send', { pane: 'p1', raw: { status: 'done', leaked: 'screen text' } })).data).toEqual(
      { status: 'done' },
    );
    expect((await host.tool('demo_send', { pane: 'p1', raw: { status: 'done', ids: ['not-minted'] } })).data).toEqual({
      status: 'refused',
      code: 'unminted_id',
    });
    const minted = host.minted.mint('window-1');
    expect((await host.tool('demo_send', { pane: 'p1', raw: { status: 'done', ids: ['window-1'] } })).data).toEqual({
      status: 'done',
      ids: [minted],
    });
    host.hold(pane('p1'));
    expect(await host.tool('demo_send', { pane: 'p1' })).toEqual({ text: 'held', isError: true });
    expect((await host.tool('demo_read', { pane: 'p2' })).text).toBe('token *******');
    expect(host.acts.map(a => a.actor)).toEqual(['ferret', 'ferret', 'ferret', 'ferret', 'ferret', 'ferret']);
  });

  test('the driven clock runs timers only when advanced', async () => {
    const clock = fixedClock('2026-11-06T09:00:00.000Z');
    const fired: number[] = [];
    clock.after(seconds(5), () => fired.push(clock.nowMs()));
    clock.every(seconds(2), () => fired.push(-clock.nowMs()));
    await clock.advance(seconds(4));
    expect(fired.length).toBe(2);
    await clock.advance(seconds(1));
    expect(fired.length).toBe(3);
    expect(clock.now()).toBe('2026-11-06T09:00:05.000Z' as never);
  });
});

toolConformance('demo', {
  plugin: demo,
  cases: [
    { tool: 'demo_send', input: { pane: 'c1' }, target: pane('c1') },
    { tool: 'demo_read', input: { pane: 'c2' }, target: pane('c2') },
  ],
});

/** A minimal in-memory carrier: the reference the carrier suite is checked against. */
function memoryCarrier(key: CarrierKey): { carrier: Carrier; connect(): CarrierPeer } {
  let layer: SessionLayer | undefined;
  let state: 'off' | 'ready' = 'off';
  const live = new Set<{ link: CarrierLink; peer: CarrierPeer & { deliver(b: Uint8Array): void; end(): void } }>();
  const carrier: Carrier = {
    async start(sessionLayer, signal) {
      layer = sessionLayer;
      state = 'ready';
      signal.addEventListener('abort', () => {
        state = 'off';
        for (const entry of live) {
          entry.link.closed('carrier stopped');
          entry.peer.end();
        }
        live.clear();
      });
    },
    status: () => ({ state, sentence: state === 'ready' ? 'In memory, ready.' : 'In memory, off.' }),
  };
  return {
    carrier,
    connect() {
      if (layer === undefined) throw new Error('not started');
      const received: Uint8Array[] = [];
      let closed = false;
      const link = layer.open(key);
      const peer = {
        send: (bytes: Uint8Array) => link.inbound(bytes),
        received: () => received,
        close: () => {
          closed = true;
          link.closed('peer left');
        },
        closed: () => closed,
        deliver: (bytes: Uint8Array) => received.push(bytes),
        end: () => {
          closed = true;
        },
      };
      const entry = { link, peer };
      live.add(entry);
      link.outbound.onReady(() => {
        for (;;) {
          const next = link.outbound.next();
          if (next === undefined) return;
          if (isSessionEnd(next)) {
            peer.end();
            return;
          }
          peer.deliver(next.bytes);
        }
      });
      return peer;
    },
  };
}

carrierConformance('memory', async () => {
  const made = memoryCarrier('memory' as CarrierKey);
  return {
    carrier: made.carrier,
    key: 'memory' as CarrierKey,
    connect: async () => made.connect(),
    flush: async () => {},
  };
});
