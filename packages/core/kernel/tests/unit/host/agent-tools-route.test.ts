/** R-0246: `POST /v1/agent/tools` — the kernel’s tool door: a tool by name, admitted and run by its own declaration. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { type Admission, AdmissionPort } from '../../../contract/bound.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, tool } from '../../../manifest/index.ts';
import kernelPlugin from '../../../plugin.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request } from './fixtures.ts';

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
const descriptor = {
  minimum: 'authenticated',
  caller: 'any',
  audit: { skip: 'test' },
  guard: { none: 'test' },
} as const;
const terminals = definePlugin({
  id: 'terminals',
  title: 'Terminals',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: {
    agentTools: [
      tool('terminal_list', { ...descriptor, input: z.strictObject({}), summary: 'list' }),
      tool('shared_name', { ...descriptor, summary: 'one of two' }),
    ],
  },
});
const browsers = definePlugin({
  id: 'browsers',
  title: 'Browsers',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: { agentTools: [tool('shared_name', { ...descriptor, summary: 'the other of two' })] },
});

/** Names of the tools whose handler actually ran. */
const ran: string[] = [];

/** Gate's per-tool answer: admits the route and every tool but the ones named, which it refuses as it refuses a caller with no standing. */
function refusingTools(refused: ReadonlySet<string>): Admission {
  const open = recordingAdmission();
  return {
    ...open,
    admit: input =>
      input.table === 'tool' && refused.has(input.descriptor.path.split('/').at(-1) ?? '')
        ? {
            outcome: 'refused',
            response: {
              status: 403,
              headers: new Map(),
              body: '{"error":"no standing for this tool","code":"forbidden"}',
            },
          }
        : open.admit(input),
  };
}

async function boot(admission: Admission = recordingAdmission()) {
  const root = await mkdtemp(`${tmpdir()}/agent-tools-`);
  roots.push(root);
  const home = `${root}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission } }) }),
      implementDaemon(terminals, {
        build: () => ({
          tools: {
            terminal_list: async () => {
              ran.push('terminal_list');
              return { text: 'two terminals', data: { surfaces: [] } };
            },
            shared_name: async () => ({ text: 'from terminals' }),
          },
        }),
      }),
      implementDaemon(browsers, { build: () => ({ tools: { shared_name: async () => ({ text: 'from browsers' }) } }) }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  return outcome.host;
}

const post = (body: string) => request('POST', '/v1/agent/tools', { body });

test('R-0246 the descriptor is today’s: no minimum, any caller, privileged carriers only, never stored', () => {
  const declared = kernelPlugin.actions?.routes.find(route => route.key === 'POST /v1/agent/tools');
  expect(declared).toMatchObject({ minimum: 'none', caller: 'any', privilegedOnly: true, noStore: true });
  expect(declared?.capability).toBeUndefined();
});

test('R-0246 a tool is found by name, run by its owner, and answered as its result', async () => {
  const host = await boot();
  try {
    const response = await host.dispatch(post(JSON.stringify({ tool: 'terminal_list', input: {} })));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ text: 'two terminals', data: { surfaces: [] } });
  } finally {
    await host.stop();
  }
});

test('R-0246 it names no ferret and no plugin: extra fields, unknown and ambiguous tools, and bad bodies are refused', async () => {
  const host = await boot();
  try {
    const refused = async (text: string) => {
      const response = await host.dispatch(post(text));
      return { status: response.status, code: (JSON.parse(response.body) as { code?: string }).code };
    };
    expect(await refused(JSON.stringify({ tool: 'terminal_list', sessionId: 'wren' }))).toEqual({
      status: 400,
      code: 'invalid_body',
    });
    expect(await refused(JSON.stringify({ tool: 'terminal_list', plugin: 'browsers' }))).toEqual({
      status: 400,
      code: 'invalid_body',
    });
    expect(await refused('not json')).toEqual({ status: 400, code: 'invalid_body' });
    expect(await refused(JSON.stringify({ tool: 'nothing_here' }))).toEqual({ status: 404, code: 'unknown_tool' });
    expect(await refused(JSON.stringify({ tool: 'shared_name' }))).toEqual({ status: 400, code: 'ambiguous_tool' });
    expect(await refused('x'.repeat(1024 * 1024 + 1))).toEqual({ status: 413, code: 'body_too_large' });
  } finally {
    await host.stop();
  }
});

test('R-0246 a tool input that does not fit its declared schema is the tool’s own refusal, not a crash', async () => {
  const host = await boot();
  try {
    const response = await host.dispatch(post(JSON.stringify({ tool: 'terminal_list', input: { extra: 1 } })));
    expect(JSON.parse(response.body)).toMatchObject({ isError: true });
  } finally {
    await host.stop();
  }
});

test('R-0246 the tool door admits the tool PER TOOL: when Gate refuses the tool’s own declaration the answer is the refusal and the tool never ran', async () => {
  ran.length = 0;
  const host = await boot(refusingTools(new Set(['terminal_list'])));
  try {
    const refused = await host.dispatch(post(JSON.stringify({ tool: 'terminal_list', input: {} })));
    expect(JSON.parse(refused.body)).toMatchObject({ isError: true });
    expect(JSON.parse(refused.body).text).not.toContain('two terminals');
    expect(ran).toEqual([]);
    // The same call with nothing refused runs the tool: the refusal above is Gate's answer, not a broken door.
    const allowed = await boot(refusingTools(new Set()));
    try {
      const response = await allowed.dispatch(post(JSON.stringify({ tool: 'terminal_list', input: {} })));
      expect(JSON.parse(response.body)).toEqual({ text: 'two terminals', data: { surfaces: [] } });
      expect(ran).toEqual(['terminal_list']);
    } finally {
      await allowed.stop();
    }
  } finally {
    await host.stop();
  }
});
