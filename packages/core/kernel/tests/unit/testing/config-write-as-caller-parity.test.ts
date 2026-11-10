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

/** Edits made to a file that already holds an edit for the owner: the writer and the testing host take the same base. */
const OVER_HELD: readonly { readonly label: string; readonly held: string; readonly patch: Record<string, unknown> }[] =
  [
    {
      label: 'a held secret, another field patched',
      held: 'env:\n  EVIL: ${secret:GITHUB_TOKEN}\n',
      patch: { note: 'x' },
    },
    {
      label: 'a held secret, the owner adds its own',
      held: 'env:\n  EVIL: ${secret:GITHUB_TOKEN}\n',
      patch: { env: { EVIL: '${secret:GITHUB_TOKEN}', OWN: '${secret:OWN_TOKEN}' } },
    },
    {
      label: 'a held loosening, the owner adds its own secret',
      held: 'limit: 99\n',
      patch: { env: { OWN: '${secret:OWN_TOKEN}' } },
    },
    { label: 'a held loosening, another field patched', held: 'limit: 99\n', patch: { note: 'x' } },
  ];

test('the testing host takes the same base as the real writer over a file holding an edit for the owner', async () => {
  for (const owner of [true, false])
    for (const other of [true, false])
      for (const { label, held, patch } of OVER_HELD) {
        const port = await real(owner, other);
        const { host, config } = await testing(owner, other);
        // the file is first held by a plain write of the same text, which asks only the plain question
        const realHeld = await port.write(mcpDef, 'acme', held);
        const testHeld = await config.write(mcpDef, 'acme', held);
        expect({ label, kind: testHeld.kind }).toEqual({ label, kind: realHeld.kind });
        const realOutcome = await port.writeAsCaller(mcpDef, 'acme', { patch });
        const testOutcome = await config.writeAsCaller(mcpDef, 'acme', { patch });
        expect({ label, owner, other, kind: testOutcome.kind }).toEqual({
          label,
          owner,
          other,
          kind: realOutcome.kind,
        });
        expect({ label, owner, other, value: config.collection(mcpDef).get('acme') }).toEqual({
          label,
          owner,
          other,
          value: port.collection(mcpDef).get('acme'),
        });
        await host.stop();
      }
});

test('the testing host never asks the owner question for a plain write, for writeAsOwner, or for an edit that adds no reference', async () => {
  let config: ConfigPort | undefined;
  const asked: { secretAdd?: true }[] = [];
  const half = implementDaemon(manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  const host = await testHost({
    plugins: [half],
    gate: {
      judgeConfigWrite: (input: { secretAdd?: true }) => (asked.push(input), 'apply'),
    } as never,
  });
  if (config === undefined) throw new Error('the half was not built');
  // a plain write that adds a reference stays held even though the admission would say yes to the owner question
  expect((await config.write(mcpDef, 'acme', ADD)).kind).toBe('held');
  expect((await config.writeAsOwner(mcpDef, 'acme', { patch: { env: { TOKEN: '${secret:ACME_TOKEN}' } } })).kind).toBe(
    'held',
  );
  // an edit that adds none asks no owner question either
  await config.writeAsCaller(mcpDef, 'other', 'note: hello\n');
  expect(asked.filter(input => input.secretAdd === true)).toEqual([]);
  expect(config.collection(mcpDef).get('acme')).toBeUndefined();
  await host.stop();
});

test('the testing host answers a stale ifMatch on writeAsCaller as a conflict, as write does', async () => {
  const { host, config } = await testing(true, true);
  expect((await config.writeAsCaller(mcpDef, 'acme', 'note: a\n', { ifMatch: 'absent' })).kind).toBe('written');
  expect((await config.writeAsCaller(mcpDef, 'acme', ADD, { ifMatch: 'absent' })).kind).toBe('conflict');
  await host.stop();
});
