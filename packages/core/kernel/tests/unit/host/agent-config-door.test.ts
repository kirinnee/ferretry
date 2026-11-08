/**
 * R-0244 / T-0032..T-0034 through a booted host: `POST /v1/agent/config` and the kernel's three config tools, with Gate
 * and Ferrets stood in for. The caller's ferret comes from the standing Gate stamped; Ferrets' port answers the owner's
 * switch; the kernel's own config writer holds a loosening for the owner.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  type Admission,
  type AdmissionDecision,
  AgentControlPort,
  type AgentControlKind,
  AdmissionPort,
} from '../../../contract/bound.ts';
import { defineConfig } from '../../../contract/index.ts';
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

/** Stand-ins for files the agent's door may name (`voice.yaml`, today's reach) and may not (`gate.yaml`, person-only). */
const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), apiKey: z.string().optional() }),
  axis: 'configure',
  loosens: (before, after) =>
    after.limit > (before?.limit ?? 10) ? [`raises the limit from ${before?.limit ?? 10} to ${after.limit}`] : [],
});
const gateDef = defineConfig({
  file: 'gate.yaml',
  schema: z.strictObject({ unlockOnOpen: z.boolean().default(true) }),
  axis: 'configure',
  personOnly: true,
  loosens: () => [],
});

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
  data: { config: [gateDef] },
});
const ferrets = definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { agentControl: AgentControlPort },
  data: { config: [voiceDef] },
});

/** Who the test says is calling, by `x-test-caller`: a ferret, the owner (admin), or nobody (the refusal Gate gives). */
function admission(): Admission {
  const decide = (request: ApiRequest, privilegedOnly: boolean, anyone: boolean): AdmissionDecision => {
    // Like Gate: a route that says `minimum: 'none'` admits whoever calls; the tool it names then admits the caller.
    if (anyone) return { outcome: 'admitted', standing: {} as unknown as CallStanding, actor: 'owner-tools' };
    // Gate's own refusal of a carrier that is not the privileged local one, for a declaration that says so.
    if (privilegedOnly && !(request.arrival.kind === 'local' && request.arrival.privileged))
      return {
        outcome: 'refused',
        response: { status: 403, headers: new Map(), body: '{"error":"forbidden","code":"forbidden"}' },
      };
    const caller = headerValue(request, 'x-test-caller');
    if (caller === undefined)
      return {
        outcome: 'refused',
        response: { status: 401, headers: new Map(), body: '{"error":"unauthorized","code":"unauthorized"}' },
      };
    // Gate's own refusal of a ferret naming another ferret's session.
    const claimed = headerValue(request, 'x-ferretry-session-id');
    if (caller === 'wren' && claimed !== undefined && claimed !== 'wren')
      return {
        outcome: 'refused',
        response: { status: 401, headers: new Map(), body: '{"error":"session_mismatch","code":"session_mismatch"}' },
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
    admit: input =>
      decide(
        input.request,
        input.descriptor.privilegedOnly === true,
        input.table === 'route' && input.descriptor.minimum === 'none',
      ),
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

const post = (
  path: string,
  body: unknown,
  caller?: string,
  extra: { readonly headers?: Record<string, string>; readonly privileged?: boolean } = {},
): ApiRequest => ({
  method: 'POST',
  path,
  query: queryFrom([]),
  headers: headersFrom({ ...(caller === undefined ? {} : { 'x-test-caller': caller }), ...extra.headers }),
  arrival: localArrival(extra.privileged ?? true),
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
    const first = json(await tools('config_write', { path: 'voice.yaml', text: 'limit: 5\n' }));
    expect(first.isError).toBeUndefined();
    expect(JSON.parse(String(first.text)).summary).toBe('Wrote voice.yaml; it is in effect.');
    const loosening = json(await tools('config_write', { path: 'voice.yaml', text: 'limit: 50\n' }));
    const answer = JSON.parse(String(loosening.text)) as { summary: string };
    expect(answer.summary).toContain(
      'waits for the owner to confirm it; the earlier version stays in effect until then',
    );
    const read = JSON.parse(String(json(await tools('config_read', {})).text)) as { summary: string };
    expect(read.summary).toContain('1 waiting for the owner');
    const secret = json(
      await tools('config_write', {
        path: 'voice.yaml',
        text: 'limit: 5\napiKey: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
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

test('R-0244 the caller is admitted BEFORE the body: no credential 401, a non-ferret 403, whatever the body says', async () => {
  const host = await boot({ switches: { on: ['settings'], asked: [] } });
  try {
    const garbage = { tool: 'nope', wat: 1 };
    expect((await host.dispatch(post('/v1/agent/config', garbage))).status).toBe(401);
    expect((await host.dispatch(post('/v1/agent/config', garbage, 'owner'))).status).toBe(403);
    // A ferret with a bad body is a 400 only once it was admitted and the switch was found on.
    expect((await host.dispatch(post('/v1/agent/config', garbage, 'wren'))).status).toBe(400);
  } finally {
    await host.stop();
  }
});

test('R-0244 the owner’s switch is asked BEFORE the body too: off, a bad body is still 403 agent_control_off', async () => {
  const host = await boot({ switches: { on: [], asked: [] } });
  try {
    const refused = await host.dispatch(post('/v1/agent/config', { tool: 'nope' }, 'wren'));
    expect(refused.status).toBe(403);
    expect(json(refused).code).toBe('agent_control_off');
  } finally {
    await host.stop();
  }
});

test('R-0244 Gate’s refusals survive through the route, no credential in today’s words: 401 missing_capability, 401 session_mismatch, 403 on a carrier that is not privileged', async () => {
  const host = await boot({ switches: { on: ['settings'], asked: [] } });
  try {
    const none = await host.dispatch(post('/v1/agent/config', { tool: 'config.read' }));
    expect(none.status).toBe(401);
    // Today's code and sentence (round-2 m-c), not Gate's `unauthorized`.
    expect(json(none)).toEqual({
      error:
        'the config tools need the session credential Ferretry gives each agent session; run this from inside an agent session',
      code: 'missing_capability',
    });
    const mismatch = await host.dispatch(
      post('/v1/agent/config', { tool: 'config.read' }, 'wren', { headers: { 'x-ferretry-session-id': 'other' } }),
    );
    expect(mismatch.status).toBe(401);
    expect(json(mismatch).code).toBe('session_mismatch');
    const relayed = await host.dispatch(
      post('/v1/agent/config', { tool: 'config.read' }, 'wren', { privileged: false }),
    );
    expect(relayed.status).toBe(403);
  } finally {
    await host.stop();
  }
});

test('R-0244 the three config tools share one declaration shape, so config_read’s declaration can admit for all three', () => {
  const tools = ['config_read', 'config_validate', 'config_write'].map(name =>
    kernelPlugin.actions?.agentTools.find(declared => declared.name === name),
  );
  const shape = (tool: (typeof tools)[number]) => ({
    minimum: tool?.minimum,
    caller: tool?.caller,
    capability: tool?.capability,
    ferretDoor: tool?.ferretDoor,
  });
  expect(shape(tools[1])).toEqual(shape(tools[0]));
  expect(shape(tools[2])).toEqual(shape(tools[0]));
});

test('T-0032 T-0033 T-0034 a person-only file (gate.yaml) and a file outside today’s reach (plugins.yaml) are refused on read, validate and write, nothing written', async () => {
  const host = await boot({ switches: { on: ['settings'], asked: [] } });
  try {
    for (const path of ['gate.yaml', 'plugins.yaml']) {
      const bodies = [
        { tool: 'config.read', path },
        { tool: 'config.validate', path, text: 'unlockOnOpen: false\n' },
        { tool: 'config.write', path, text: 'plugins:\n  warden: off\n' },
      ];
      for (const body of bodies) {
        const refused = await host.dispatch(post('/v1/agent/config', body, 'wren'));
        expect(refused.status).toBe(400);
        expect(json(refused).code).toBe('invalid_request');
        expect(String(json(refused).error)).toContain('not a Ferretry configuration file — use machine.yaml');
      }
    }
    // Nothing was written, and the listing does not even name them.
    const listed = json(await host.dispatch(post('/v1/agent/config', { tool: 'config.read' }, 'wren')));
    expect(JSON.stringify(listed)).not.toContain('plugins.yaml');
    expect(JSON.stringify(listed)).not.toContain('gate.yaml');
    const status = json(await host.dispatch(get('/v1/config/status', 'owner')));
    expect(JSON.stringify(status.pending)).toBe('[]');
  } finally {
    await host.stop();
  }
});
