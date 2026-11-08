/**
 * R-0244 / T-0032..T-0034 through a booted host: `POST /v1/agent/config` and the kernel's three config tools, with Gate
 * and Ferrets stood in for. The caller's ferret comes from the standing Gate stamped; Ferrets' port answers the owner's
 * switch; the kernel's own config writer holds a loosening for the owner.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  type Admission,
  type AdmissionDecision,
  AgentControlPort,
  type AgentControlKind,
  AdmissionPort,
} from '../../../contract/bound.ts';
import { type ApiRequest, headerValue, headersFrom, queryFrom } from '../../../contract/http.ts';
import type { CallStanding } from '../../../contract/route.ts';
import { bootHost } from '../../../host/host.ts';
import { inventorySurfacesOf } from '../../../host/kernel-half.ts';
import { localArrival } from '../../../host/listener.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import kernelPlugin from '../../../plugin.ts';
import { fixedClock } from '../../../testing/clock.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});
const ferrets = definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { agentControl: AgentControlPort },
});

/** Who the test says is calling, by `x-test-caller`: a ferret, the owner (admin), or nobody (the refusal Gate gives). */
function admission(): Admission {
  const decide = (request: ApiRequest): AdmissionDecision => {
    const caller = headerValue(request, 'x-test-caller');
    if (caller === undefined)
      return {
        outcome: 'refused',
        response: { status: 401, headers: new Map(), body: '{"error":"unauthorized","code":"unauthorized"}' },
      };
    const credential =
      caller === 'wren'
        ? { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' }
        : { kind: 'authenticated', tokenClass: 'admin' };
    return {
      outcome: 'admitted',
      standing: { credential } as unknown as CallStanding,
      actor: caller === 'wren' ? 'ferret' : 'owner-tools',
    };
  };
  return {
    admit: input => decide(input.request),
    admitMember: () => {
      throw new Error('no members here');
    },
    readmit: () => true,
    inventory: (_request, entries) => entries,
  };
}

interface Switches {
  on: readonly AgentControlKind[];
  readonly asked: string[];
}

async function boot(options: { readonly switches?: Switches } = {}) {
  const root = await mkdtemp(`${tmpdir()}/agent-config-`);
  roots.push(root);
  const home = `${root}/home`;
  const control = options.switches;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission: admission() } }) }),
      ...(control === undefined
        ? []
        : [
            implementDaemon(ferrets, {
              build: () => ({
                provides: {
                  agentControl: {
                    allows: async (ferret: string, kind: AgentControlKind) => {
                      control.asked.push(`${ferret}:${kind}`);
                      return control.on.includes(kind);
                    },
                  },
                },
              }),
            }),
          ]),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  return outcome.host;
}

const post = (path: string, body: unknown, caller?: string): ApiRequest => ({
  method: 'POST',
  path,
  query: queryFrom([]),
  headers: headersFrom(caller === undefined ? {} : { 'x-test-caller': caller }),
  arrival: localArrival(true),
  text: async () => JSON.stringify(body),
});
const get = (path: string, caller?: string): ApiRequest => ({
  ...post(path, undefined, caller),
  method: 'GET',
  text: async () => '',
});

const json = (response: { readonly body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('T-0032 T-0033 T-0034 every ferret’s tool list carries the three config tools, with today’s names', () => {
  const surfaces = inventorySurfacesOf(kernelPlugin);
  const names = surfaces.flatMap(surface => ('name' in surface ? [surface.name] : []));
  expect(names).toEqual(expect.arrayContaining(['config_read', 'config_validate', 'config_write']));
});

test('R-0244 the switch off → 403 agent_control_off through the route, and the owner’s admin token is not a ferret', async () => {
  const switches: Switches = { on: [], asked: [] };
  const host = await boot({ switches });
  try {
    const off = await host.dispatch(post('/v1/agent/config', { tool: 'config.read' }, 'wren'));
    expect(off.status).toBe(403);
    expect(json(off).code).toBe('agent_control_off');
    expect(switches.asked).toEqual(['wren:settings']);
    const notFerret = await host.dispatch(post('/v1/agent/config', { tool: 'config.read' }, 'owner'));
    expect(notFerret.status).toBe(403);
    expect(switches.asked).toEqual(['wren:settings']);
    const anonymous = await host.dispatch(post('/v1/agent/config', { tool: 'config.read' }));
    expect(anonymous.status).toBe(401);
  } finally {
    await host.stop();
  }
});

test('R-0244 the port unbound (Ferrets absent) → every config act is refused through the route and the tools', async () => {
  const host = await boot();
  try {
    const route = await host.dispatch(post('/v1/agent/config', { tool: 'config.read' }, 'wren'));
    expect(route.status).toBe(403);
    expect(json(route).code).toBe('agent_control_off');
    const tool = await host.dispatch(post('/v1/agent/tools', { tool: 'config_read', input: {} }, 'wren'));
    expect(json(tool)).toMatchObject({ isError: true });
  } finally {
    await host.stop();
  }
});

test('R-0244 the switch on → the route lists the files; a body that names a ferret is refused', async () => {
  const host = await boot({ switches: { on: ['settings'], asked: [] } });
  try {
    const listed = await host.dispatch(post('/v1/agent/config', { tool: 'config.read' }, 'wren'));
    expect(listed.status).toBe(200);
    expect(String(json(listed).summary)).toContain('configuration files in');
    const named = await host.dispatch(post('/v1/agent/config', { tool: 'config.read', ferret: 'other' }, 'wren'));
    expect(named.status).toBe(400);
  } finally {
    await host.stop();
  }
});

test('T-0034 a loosening config_write through the tool door is HELD and NOT applied; a raw secret is refused', async () => {
  const host = await boot({ switches: { on: ['settings'], asked: [] } });
  try {
    const tools = (tool: string, input: unknown) => host.dispatch(post('/v1/agent/tools', { tool, input }, 'wren'));
    const first = json(await tools('config_write', { path: 'plugins.yaml', text: 'plugins:\n  extra: off\n' }));
    expect(first.isError).toBeUndefined();
    expect(JSON.parse(String(first.text)).summary).toBe('Wrote plugins.yaml; it is in effect.');
    const loosening = json(await tools('config_write', { path: 'plugins.yaml', text: 'plugins:\n  extra: on\n' }));
    const answer = JSON.parse(String(loosening.text)) as { summary: string };
    expect(answer.summary).toContain(
      'waits for the owner to confirm it; the earlier version stays in effect until then',
    );
    const read = JSON.parse(String(json(await tools('config_read', {})).text)) as { summary: string };
    expect(read.summary).toContain('1 waiting for the owner');
    const secret = json(
      await tools('config_write', {
        path: 'plugins.yaml',
        text: 'plugins:\n  extra: off\napiKey: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
      }),
    );
    expect(String(secret.text)).not.toContain('sk-ant');
  } finally {
    await host.stop();
  }
});

test('R-0073 GET /v1/config/status answers the directory, files, issues and pending', async () => {
  const host = await boot({ switches: { on: [], asked: [] } });
  try {
    const status = await host.dispatch(get('/v1/config/status', 'owner'));
    expect(status.status).toBe(200);
    expect(Object.keys(json(status)).toSorted()).toEqual(['checkedAt', 'directory', 'files', 'issues', 'pending']);
  } finally {
    await host.stop();
  }
});
