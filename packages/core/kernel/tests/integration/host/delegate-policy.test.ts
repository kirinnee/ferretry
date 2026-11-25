import { expect, test } from 'bun:test';
import { cap, DEFAULT_GATE_CONFIG } from '../../../../gate/contract/index.ts';
import { jsonResponse, type Admission, type RouteKey } from '../../../contract/index.ts';
import { delegateProblems } from '../../../manifest/delegate.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { Dispatcher, type MountedRoute } from '../../../host/dispatch.ts';
import { delegatePort } from '../../../host/delegate.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { gateWorld } from './delegate-support.ts';
import { DELEGATE_ROUTES } from '../../../contract/ports/delegate.ts';

const keys: readonly RouteKey[] = [
  'GET /v1/ferrets',
  'GET /v1/ferrets/:ferretId',
  'GET /v1/ferrets/:ferretId/logs',
  'POST /v1/ferrets/:ferretId/send',
  'POST /v1/ferrets/:ferretId/stop',
  'POST /v1/restarts',
  'POST /v1/ferrets',
  'GET /v1/projects',
  'GET /v1/agenda/open',
  'POST /v1/ferrets/:ferretId/agenda',
  'GET /v1/machine/agenda',
  'POST /v1/machine/agenda',
];
const manifest = (delegate: readonly RouteKey[]): Manifest =>
  ({ id: 'connector', permissions: { delegate } }) as Manifest;
const routes = daemonImplementations.flatMap(implementation => implementation.manifest.actions?.routes ?? []);
const owner = { plugin: 'fixture', title: 'Fixture', serving: () => ({ kind: 'serving' as const }) };
const grant = 'cg_abcdefghij';

test('the delegate fence is exactly the twelve parity route keys, including approved person routes', () => {
  expect([...DELEGATE_ROUTES].sort()).toEqual([...keys].sort());
  expect(
    delegateProblems(
      manifest(keys),
      daemonImplementations.map(i => i.manifest),
    ),
  ).toEqual([]);
  const accepted = routes.filter(route => delegateProblems(manifest([route.key])).length === 0).map(r => r.key);
  expect(accepted.sort()).toEqual([...keys].sort());
  expect(delegateProblems(manifest(['GET /missing']))).not.toEqual([]);
});

test('every delegated read, even a public or capability-free descriptor, needs a determined fleet.use grant', async () => {
  const w = await gateWorld();
  for (const key of ['GET /v1/projects', 'GET /v1/agenda/open'] as const) {
    const actual = routes.find(route => route.key === key);
    if (actual === undefined) throw new Error(`missing ${key}`);
    expect(actual.capability).toBeUndefined();
    for (const minimum of [actual.minimum, 'none'] as const) {
      let handled = 0;
      let admission: Admission | undefined = w.gate;
      const dispatcher = new Dispatcher(
        { admission: () => admission, outputGuard: () => undefined, version: '5.0.0' },
        {
          routes: [
            {
              ...actual,
              minimum,
              owner,
              handle: async () => {
                handled++;
                return jsonResponse({ ok: true });
              },
            } as MountedRoute,
          ],
          sockets: [],
          memberRoutes: [],
        },
      );
      const port = delegatePort({
        manifest: manifest([key]),
        dispatcher: () => dispatcher,
        admission: () => w.gate,
        refused: () => {},
      });
      const call = () => port.call({ grant }, { method: 'GET', path: actual.path });
      w.policy = DEFAULT_GATE_CONFIG;
      expect((await call()).status).toBe(200);
      expect(handled).toBe(1);
      w.policy = {
        ...DEFAULT_GATE_CONFIG,
        grants: { ...DEFAULT_GATE_CONFIG.grants, fleet: { use: false, configure: false } },
      };
      expect(await call()).toMatchObject({ status: 403, body: expect.stringContaining('fleet') });
      w.policy = undefined;
      expect(await call()).toMatchObject({ status: 403, body: expect.stringContaining('grant_undetermined') });
      admission = undefined;
      expect(await call()).toMatchObject({ status: 503, body: expect.stringContaining('admission_unavailable') });
      expect(handled).toBe(1);
    }
  }
});

test('only the exact start/restart descriptors waive fleet.configure step-up; every other configure still needs proof', async () => {
  const w = await gateWorld();
  const configure = routes.filter(
    route =>
      route.capability?.capability === cap('fleet', 'configure').capability && route.capability.axis === 'configure',
  );
  expect(configure.length).toBeGreaterThan(30);
  for (const descriptor of configure) {
    const decision = w.gate.admit({
      table: 'route',
      descriptor,
      params: new Map(),
      request: {
        method: descriptor.method,
        path: descriptor.path,
        query: new Map(),
        headers: new Map(),
        arrival: { kind: 'delegated', by: 'connector', grant },
        text: async () => '',
      },
    });
    if (['POST /v1/restarts', 'POST /v1/ferrets'].includes(descriptor.key)) expect(decision.outcome).toBe('admitted');
    else
      expect(decision).toMatchObject({
        outcome: 'refused',
        response: { status: 403, body: expect.stringContaining('grant_step_up_required') },
      });
  }
});
