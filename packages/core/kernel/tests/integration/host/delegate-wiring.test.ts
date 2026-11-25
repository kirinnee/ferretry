import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { cap, DEFAULT_GATE_CONFIG } from '../../../../gate/contract/index.ts';
import { gateWorld } from './delegate-support.ts';
import { AdmissionPort, definePort, jsonResponse, type DelegatePort } from '../../../contract/index.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';

const Delegate = definePort<DelegatePort>('fixture-connector-delegate');
const read = route('GET /v1/fixture', {
  minimum: 'operator',
  caller: 'person',
  capability: cap('fleet', 'use'),
  audit: { skip: 'fixture' },
  guard: { none: 'fixture attribution' },
});

test('real boot wires the scoped delegate after Gate binding and refuses calls once its plugin stops', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-u2-`);
  const previous = { home: process.env.HOME, fyHome: process.env.FY_HOME };
  process.env.HOME = home;
  process.env.FY_HOME = home;
  const w = await gateWorld();
  let delegate: DelegatePort | undefined;
  const connector = implementDaemon(
    definePlugin({
      id: 'connector',
      title: 'Connector',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { delegate: [read.key] },
      provides: { delegate: Delegate },
    }),
    {
      build: ctx => {
        delegate = ctx.kernel.delegate;
        return { provides: { delegate } };
      },
    },
  );
  const gate = implementDaemon(
    definePlugin({
      id: 'gate',
      title: 'Gate',
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      provides: { admission: AdmissionPort },
    }),
    { build: () => ({ provides: { admission: w.gate } }) },
  );
  const target = implementDaemon(
    definePlugin({
      id: 'fixture',
      title: 'Fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      actions: { routes: [read] },
    }),
    {
      build: () => ({
        routes: { [read.key]: async call => jsonResponse({ actor: call.actor, local: call.presentation?.local }) },
      }),
    },
  );
  const boot = await bootHost({
    home,
    version: '5.0.0',
    implementations: [gate, connector, target],
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
  });
  try {
    expect(boot.kind).toBe('running');
    if (boot.kind !== 'running' || delegate === undefined) throw new Error('fixture did not boot the connector');
    const scoped = delegate;
    const call = () => scoped.call({ grant: 'cg_abcdefghij' }, { method: 'GET', path: '/v1/fixture' });
    expect(await call()).toMatchObject({
      status: 200,
      body: JSON.stringify({ actor: 'connector:cg_abcdefghij', local: false }),
    });
    w.policy = {
      ...DEFAULT_GATE_CONFIG,
      grants: { ...DEFAULT_GATE_CONFIG.grants, fleet: { use: false, configure: false } },
    };
    expect((await call()).status).toBe(403);
    await boot.host.stop();
    expect((await call()).status).toBe(500);
  } finally {
    if (boot.kind === 'running') await boot.host.stop();
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.fyHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previous.fyHome;
    await rm(home, { recursive: true, force: true });
  }
});
