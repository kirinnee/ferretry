import { describe, expect, test } from 'bun:test';
import { audit, cap, DEFAULT_GATE_CONFIG, STEP_UP_ACTS } from '../../../../gate/contract/index.ts';
import { gateWorld } from './delegate-support.ts';
import {
  bytesResponse,
  jsonResponse,
  type ApiResponse,
  type CallContext,
  type RouteKey,
} from '../../../contract/index.ts';
import { definePlugin, route, type RouteDecl } from '../../../manifest/index.ts';
import { Dispatcher, type MountedRoute } from '../../../host/dispatch.ts';
import { delegatePort } from '../../../host/delegate.ts';
import { planGraph } from '../../../host/graph.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';

const grant = 'cg_abcdefghij';
const owner = { plugin: 'ferrets', title: 'Ferrets', serving: () => ({ kind: 'serving' as const }) };
const base = {
  minimum: 'operator',
  caller: 'person',
  guard: { none: 'fixture names only' },
  audit: audit('session.stopped'),
} as const;
const read = route('GET /v1/ferrets/:ferretId', { ...base, capability: cap('fleet', 'use') });
const actualFleetRoute = (key: RouteKey) => {
  const found = daemonImplementations
    .find(implementation => implementation.manifest.id === 'ferrets')
    ?.manifest.actions?.routes?.find((decl: RouteDecl) => decl.key === key);
  if (found === undefined) throw new Error(`real Ferrets manifest has no ${key}`);
  return found;
};
const restart = route('POST /v1/restarts', actualFleetRoute('POST /v1/restarts'));
const start = route('POST /v1/ferrets', actualFleetRoute('POST /v1/ferrets'));
const act = route('POST /v1/proof', { ...base, capability: cap('fleet', 'use', { act: STEP_UP_ACTS.catalogInstall }) });
const terminal = route('POST /v1/terminal-proof', { ...base, capability: cap('terminal', 'use') });
const connector = (keys: readonly RouteKey[] = [read.key, restart.key, start.key, act.key]) =>
  definePlugin({
    id: 'connector',
    title: 'Connector',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    permissions: { delegate: keys },
  });

async function fixture(
  handle: (call: CallContext) => Promise<ApiResponse> = async call =>
    jsonResponse({
      actor: call.actor,
      credential: call.credential,
      local: call.presentation?.local,
      governed: call.governance?.governed,
      headers: Object.fromEntries(call.request.headers),
      arrival: call.request.arrival,
      clientAddress: call.request.clientAddress,
      fresh: call.claimFreshStepUp?.(),
      stored: call.claimStoredProof !== undefined,
    }),
) {
  const w = await gateWorld();
  const mounted: MountedRoute[] = [read, restart, start, act, terminal].map(decl => ({
    ...decl,
    owner: owner as MountedRoute['owner'],
    handle,
  }));
  const dispatcher = new Dispatcher(
    { admission: () => w.gate, outputGuard: () => undefined, version: '5.0.0' },
    { routes: mounted, sockets: [], memberRoutes: [] },
  );
  const log: string[] = [];
  const port = (keys?: RouteKey[]) =>
    delegatePort({
      manifest: connector(keys),
      dispatcher: () => dispatcher,
      admission: () => w.gate,
      refused: key => log.push(key),
    });
  return { w, dispatcher, port, log };
}

describe('delegation crosses the real Gate', () => {
  test('connector is remote and governed by daemon-wide grants, never host or a device', async () => {
    const { w, port } = await fixture();
    const call = () => port().call({ grant }, { method: 'GET', path: '/v1/ferrets/F12' });
    const allowed = await call();
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({
      actor: `connector:${grant}`,
      credential: { tokenClass: 'connector', grant },
      local: false,
      governed: true,
      fresh: false,
      arrival: { kind: 'delegated', by: 'connector', grant },
      clientAddress: 'connector',
    });
    expect((await w.recorded()).find(row => row.actor.kind === 'connector')).toMatchObject({
      actor: { kind: 'connector' },
      detail: { grant },
    });
    w.policy = {
      ...DEFAULT_GATE_CONFIG,
      grants: { ...DEFAULT_GATE_CONFIG.grants, fleet: { use: false, configure: false } },
    };
    expect(await call()).toMatchObject({ status: 403, body: expect.stringContaining('fleet') });
    w.policy = undefined;
    expect(await call()).toMatchObject({ status: 403, body: expect.stringContaining('grant_undetermined') });
  });

  test('fleet configure and FLEET_START pass default grants and refuse fleet.configure off', async () => {
    const { w, port } = await fixture();
    for (const path of ['/v1/restarts', '/v1/ferrets']) {
      expect((await port().call({ grant }, { method: 'POST', path, body: {} })).status).toBe(200);
    }
    w.policy = {
      ...DEFAULT_GATE_CONFIG,
      grants: { ...DEFAULT_GATE_CONFIG.grants, fleet: { use: true, configure: false } },
    };
    for (const path of ['/v1/restarts', '/v1/ferrets'])
      expect((await port().call({ grant }, { method: 'POST', path })).status).toBe(403);
  });

  test('an explicit passkey act is refused even on fleet.use', async () => {
    const { port } = await fixture();
    expect(await port().call({ grant }, { method: 'POST', path: '/v1/proof' })).toMatchObject({
      status: 403,
      body: expect.stringContaining('grant_step_up_required'),
    });
  });

  test('only the request id crosses; a matched template must be declared', async () => {
    const { w, port, log } = await fixture();
    const result = await port([read.key]).call({ grant }, {
      method: 'GET',
      path: '/v1/ferrets/F12',
      requestId: 'fixture-request',
      headers: { authorization: `Bearer ${w.admin}`, host: '127.0.0.1' },
    } as Parameters<ReturnType<typeof port>['call']>[1]);
    expect(JSON.parse(result.body).headers).toEqual({ 'x-fy-request-id': 'fixture-request' });
    expect((await port([]).call({ grant }, { method: 'GET', path: '/v1/ferrets/F12' })).status).toBe(500);
    expect(log).toEqual([read.key]);
    expect((await port().call({ grant: 'invalid' }, { method: 'GET', path: '/v1/ferrets/F12' })).status).toBe(500);
  });

  test('the final check precedes the host credential mask', async () => {
    const { w, port } = await fixture(async () => ({
      ...jsonResponse({ before: w.admin }),
      late: () => jsonResponse({ final: `${w.admin} ${w.warden}` }),
    }));
    const answer = await port().call({ grant }, { method: 'GET', path: '/v1/ferrets/F12' });
    expect(answer.body).not.toContain(w.admin);
    expect(answer.body).not.toContain(w.warden);
    expect(JSON.parse(answer.body)).toEqual({ final: '[redacted] [redacted]' });
  });

  test('manifest graph refuses a non-allow-listed plugin and an unknown route key', () => {
    const targets = definePlugin({
      id: 'ferrets',
      title: 'Ferrets',
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      actions: { routes: [read, restart, start, act] },
    });
    expect(
      planGraph(
        [targets, connector(['GET /missing'])],
        () => true,
        () => [],
      ).refused,
    ).toMatchObject([{ plugin: 'connector', sentence: expect.stringContaining('GET /missing') }]);
    expect(() => definePlugin({ ...connector(), id: 'other' })).toThrow('delegate');
  });

  test('non-fleet passkey demands and direct forged delegated dispatch cannot bypass Gate', async () => {
    const { port, dispatcher } = await fixture();
    expect(await port([terminal.key]).call({ grant }, { method: 'POST', path: '/v1/terminal-proof' })).toMatchObject({
      status: 403,
      body: expect.stringContaining('grant_step_up_required'),
    });
    expect(
      (
        await dispatcher.dispatch({
          method: 'GET',
          path: '/v1/ferrets/F12',
          query: new Map(),
          headers: new Map(),
          arrival: { kind: 'delegated', by: 'connector', grant },
          text: async () => '',
        })
      ).status,
    ).toBe(500);
  });

  test('binary or unmaskable delegated answers are withheld', async () => {
    const binary = await fixture(async () =>
      bytesResponse(new TextEncoder().encode('fixture-bytes'), 'application/octet-stream'),
    );
    expect(await binary.port().call({ grant }, { method: 'GET', path: '/v1/ferrets/F12' })).toMatchObject({
      status: 409,
      body: expect.stringContaining('withheld'),
    });
    const unmaskable = await fixture();
    unmaskable.w.gate.maskHostCredentials = () => {
      throw new Error('fixture unavailable');
    };
    expect(await unmaskable.port().call({ grant }, { method: 'GET', path: '/v1/ferrets/F12' })).toMatchObject({
      status: 409,
      body: expect.stringContaining('withheld'),
    });
  });

  test('delegate forwards JSON and query, honours body limits, and masks response headers', async () => {
    const { w, port } = await fixture(async call =>
      jsonResponse({ body: await call.request.text(64), query: [...call.request.query] }, 200, {
        'x-fixture': w.admin,
      }),
    );
    const result = await port().call(
      { grant },
      { method: 'POST', path: '/v1/restarts', body: { id: 'F12' }, query: new Map([['how', ['now']]]) },
    );
    expect(JSON.parse(result.body)).toEqual({ body: '{"id":"F12"}', query: [['how', ['now']]] });
    expect(result.headers.get('x-fixture')).toBe('[redacted]');
    expect((await port().call({ grant }, { method: 'POST', path: '/v1/restarts', body: 'x'.repeat(100) })).status).toBe(
      413,
    );
  });
});
