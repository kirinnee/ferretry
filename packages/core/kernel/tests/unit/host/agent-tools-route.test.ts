/** R-0246: `POST /v1/agent/tools` — the kernel’s tool door: a tool by name, admitted and run by its own declaration. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort } from '../../../contract/bound.ts';
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

async function boot() {
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
      implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) }),
      implementDaemon(terminals, {
        build: () => ({
          tools: {
            terminal_list: async () => ({ text: 'two terminals', data: { surfaces: [] } }),
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
