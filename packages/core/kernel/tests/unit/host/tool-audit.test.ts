import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { instantFromEpochMs } from '@ferretry/std';
import { AdmissionPort, type RecordedCall } from '../../../contract/bound.ts';
import { ApiError } from '../../../contract/http.ts';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testPrincipal } from '../../../testing/admission.ts';
import { recordingAdmission, request } from './fixtures.ts';

const homes: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test('audited tool handlers report every settled outcome exactly once and skip calls that never execute', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-tool-audit-`);
  homes.push(home);
  const admission = recordingAdmission(path => path !== '/denied');
  const records: RecordedCall[] = [];
  admission.recorded = call => {
    records.push(call);
  };
  const tool = (name: string, audit = true) =>
    ({
      name,
      minimum: 'authenticated',
      caller: 'any',
      guard: { none: 'test' },
      audit: audit ? { record: 'tool.ran' as never } : { skip: 'test' },
      input: z.string(),
    }) as const;
  const manifest = definePlugin({
    id: 'board',
    title: 'Board',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: {
      agentTools: [tool('ok'), tool('error'), tool('refused'), tool('throws'), tool('plain', false), tool('missing')],
    },
  });
  let release = () => {};
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    implementations: [
      implementDaemon(
        definePlugin({
          id: 'gate',
          title: 'Gate',
          version: '5.0.0',
          api: 5,
          core: true,
          kinds: [],
          provides: { admission: AdmissionPort },
        }),
        { build: () => ({ provides: { admission } }) },
      ),
      implementDaemon(manifest, {
        build: () => ({
          tools: {
            ok: async () => {
              await pending;
              return { text: 'ok' };
            },
            error: async () => ({ text: 'failed', isError: true }),
            refused: async () => {
              throw new ApiError(409, 'conflict', 'conflict');
            },
            throws: async () => {
              throw new Error('failed');
            },
            plain: async () => ({ text: 'plain' }),
          },
        }),
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  const host = outcome.host;
  hosts.push(host);
  const input = {
    ...request('POST', '/tools'),
    principal: testPrincipal({ kind: 'device', holder: 'device-a' }, instantFromEpochMs(1000)),
  };
  const first = host.callTool('board', 'ok', 'input', input);
  await new Promise(resolve => setImmediate(resolve));
  expect(records).toEqual([]);
  release();
  expect(await first).toEqual({ text: 'ok' });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    table: 'tool',
    status: 200,
    actor: 'owner-tools',
    standing: { actor: 'owner' },
    descriptor: { name: 'ok', path: '/v1/tools/board/ok', method: 'POST' },
  });
  expect(records[0]?.request).toBe(input);
  expect(records[0]?.principal).toBe(input.principal);
  expect(records[0]?.params.size).toBe(0);
  await host.callTool('board', 'error', 'input', input);
  await host.callTool('board', 'refused', 'input', input);
  await host.callTool('board', 'throws', 'input', input);
  expect(records.map(call => call.status)).toEqual([200, 500, 409, 500]);
  await host.callTool('board', 'plain', 'input', input);
  await host.callTool('board', 'missing', 'input', input);
  await host.callTool('board', 'unknown', 'input', input);
  await host.callTool('board', 'ok', 42, input);
  await host.callTool('board', 'ok', 'input', request('POST', '/denied'));
  const board = host.plugins.get('board');
  if (board === undefined) throw new Error('expected Board to be mounted');
  board.status = 'failed';
  await host.callTool('board', 'ok', 'input', input);
  board.status = 'serving';
  expect(records).toHaveLength(4);
  admission.recorded = () => {
    throw new Error('recorder down');
  };
  expect(await host.callTool('board', 'ok', 'input', input)).toEqual({ text: 'ok' });
});
