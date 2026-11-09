import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import type { ConfigPort } from '../../../contract/ports.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';
import { captureLog, HOME, manualClock } from '../host-config/support.ts';

/**
 * The testing host's `ConfigPort.writeAsCaller` stays in step with the real writer: asked the same owner question (an
 * input with `secretAdd`) and the same plain question, it answers the same kind and leaves the same value in effect.
 */
const mcpDef = defineConfig({
  collection: 'mcp',
  name: /^[a-z]{1,20}$/,
  schema: z.strictObject({
    env: z.record(z.string(), z.string()).default({}),
    note: z.string().optional(),
    limit: z.number().int().default(10),
  }),
  axis: 'configure',
  loosens: (before, after) => (after.limit > (before?.limit ?? 10) ? ['raises the limit'] : []),
});

const manifest = definePlugin({
  id: 'mcp',
  title: 'MCP',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [mcpDef] },
});

async function testing(owner: boolean, other: boolean) {
  let config: ConfigPort | undefined;
  const half = implementDaemon(manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  const host = await testHost({
    plugins: [half],
    gate: {
      judgeConfigWrite: (input: { secretAdd?: true }) =>
        (input.secretAdd === true ? owner : other) ? 'apply' : 'hold',
    } as never,
  });
  if (config === undefined) throw new Error('the half was not built');
  return { host, config };
}

async function real(owner: boolean, other: boolean) {
  const files = createConfigFiles({
    home: HOME,
    fs: createMemoryHostFs(),
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'mcp', def: mcpDef }],
    judge: input => (input.secretAdd === true ? owner : other),
  });
  await files.reload();
  return files.port('mcp');
}

const ADD = 'env:\n  TOKEN: ${secret:ACME_TOKEN}\n';
const EDITS: readonly string[] = [
  ADD,
  `${ADD}limit: 50\n`,
  'limit: 50\n',
  'limit: 5\n',
  'note: hello\n',
  'limit: many\n',
];

test('the testing host answers writeAsCaller as the real writer does, for every edit and every pair of verdicts', async () => {
  for (const owner of [true, false])
    for (const other of [true, false])
      for (const edit of EDITS) {
        const port = await real(owner, other);
        const { host, config } = await testing(owner, other);
        const realOutcome = await port.writeAsCaller(mcpDef, 'acme', edit);
        const testOutcome = await config.writeAsCaller(mcpDef, 'acme', edit);
        const label = { owner, other, edit };
        expect({ ...label, kind: testOutcome.kind === 'refused' ? 'refused' : testOutcome.kind }).toEqual({
          ...label,
          kind: realOutcome.kind === 'written' ? 'written' : realOutcome.kind,
        });
        expect({ ...label, value: config.collection(mcpDef).get('acme') }).toEqual({
          ...label,
          value: port.collection(mcpDef).get('acme'),
        });
        await host.stop();
      }
});

test('the testing host holds a writeAsCaller whose owner question is not answered yes, and ignores injected options', async () => {
  const { host, config } = await testing(false, true);
  const injected = { asOwner: true, byPlugin: false, judge: () => true } as unknown as { readonly ifMatch?: string };
  expect((await config.writeAsCaller(mcpDef, 'acme', ADD, injected)).kind).toBe('held');
  expect(config.collection(mcpDef).get('acme')).toBeUndefined();
  await host.stop();
});

test('the testing host answers a stale ifMatch on writeAsCaller as a conflict, as write does', async () => {
  const { host, config } = await testing(true, true);
  expect((await config.writeAsCaller(mcpDef, 'acme', 'note: a\n', { ifMatch: 'absent' })).kind).toBe('written');
  expect((await config.writeAsCaller(mcpDef, 'acme', ADD, { ifMatch: 'absent' })).kind).toBe('conflict');
  await host.stop();
});
