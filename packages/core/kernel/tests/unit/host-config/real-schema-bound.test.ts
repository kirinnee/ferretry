/**
 * Every configuration file kind this build declares, checked against its OWN schema at the size cap: each answers
 * within one hard bound at every door a text comes in by — `config_validate`, `config_write` and `config_read` for a
 * file an agent may name, the owner's write and read otherwise, and a reload of it hand-written — and no answer lists
 * more than {@link MAX_CONFIG_ISSUES} problems and one sentence counting the rest. Boot is
 * `../host/config-real-schema-boot.test.ts`.
 *
 * The kinds come from the generated registry: a plugin that declares a new file is swept here without being listed.
 */
import { describe, expect, test } from 'bun:test';
import { AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import type { ConfigTarget } from '../../../contract/ports.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { countProblems, MAX_CONFIG_ISSUES } from '../../../host/config/check.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { CONFIG_FILE_MAX_BYTES, configTextTooLarge } from '../../../host/config/yaml-text.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { type DeclaredKind, declaredKinds, mcpReviewShapes, sweepTextOf } from './real-schemas.ts';
import { captureLog, HOME, manualClock } from './support.ts';

/** A hard bound per call, far above one linear pass: the shapes this guards took 4–16 s at this size. */
const BOUND_MS = 1500;
const ferretStanding = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
const KINDS = declaredKinds();
const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);

/** Every kind declared, the swept one's file seeded with `text` before the first load. */
function world(kind: DeclaredKind, text?: string) {
  const fs = createMemoryHostFs();
  if (text !== undefined) fs.seed(`${HOME}/config/${kind.path}`, text);
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: KINDS.map(({ plugin, def }) => ({ plugin, def })),
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async () => true }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const target: ConfigTarget = {
    plugin: kind.plugin,
    def: kind.def,
    ...(kind.name === undefined ? {} : { name: kind.name }),
  };
  return { fs, files, agent, target };
}

async function timed<T>(act: () => Promise<T> | T): Promise<{ readonly ms: number; readonly value: T }> {
  const started = performance.now();
  const value = await act();
  return { ms: performance.now() - started, value };
}

/** At most the cap's issues and one more, and a count that is every problem. */
function capped(issues: readonly { readonly message: string }[] | undefined): void {
  expect((issues ?? []).length).toBeLessThanOrEqual(MAX_CONFIG_ISSUES + 1);
}

describe('the kinds swept', () => {
  test('every declared kind is swept, an agent-reachable one among them, and each text is at the cap', () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(30);
    expect(KINDS.some(kind => kind.path === 'mcp/sweep.yaml' && kind.agentMayName)).toBe(true);
    for (const kind of KINDS) {
      const [, text] = sweepTextOf(kind, CONFIG_FILE_MAX_BYTES);
      expect(configTextTooLarge(text)).toBe(false);
      expect(text.length).toBeGreaterThan(CONFIG_FILE_MAX_BYTES - 1024);
    }
  });
});

/** Every door, timed, for one kind and one hostile text. */
async function everyDoor(kind: DeclaredKind, text: string): Promise<void> {
  // A reload of the file hand-written (the first load of a home that holds it is what boot runs).
  const { agent, files, fs, target } = world(kind, text);
  expect((await timed(() => files.reload())).ms).toBeLessThan(BOUND_MS);
  fs.seed(`${HOME}/config/${kind.path}`, `${text.slice(0, -1)}\n`);
  expect((await timed(() => files.reload())).ms).toBeLessThan(BOUND_MS);
  capped(files.status().issues.filter(issue => issue.path === kind.path));
  // A text that is not the one on disk, so no check made of it before is reused.
  const fresh = `${text.slice(0, -1)} `;
  if (kind.agentMayName) {
    const read = await timed(() => agent.run(call({ tool: 'config.read', path: kind.path }), ferretStanding));
    expect(read.ms).toBeLessThan(BOUND_MS);
    capped(read.value.issues);
    const validate = await timed(() =>
      agent.run(call({ tool: 'config.validate', path: kind.path, text: fresh }), ferretStanding),
    );
    expect(validate.ms).toBeLessThan(BOUND_MS);
    capped(validate.value.issues);
    const write = await timed(() =>
      agent.run(call({ tool: 'config.write', path: kind.path, text: `${fresh.slice(0, -1)}\t` }), ferretStanding),
    );
    expect(write.ms).toBeLessThan(BOUND_MS);
    capped(write.value.issues);
  } else {
    const read = await timed(() => files.writer().read(target));
    expect(read.ms).toBeLessThan(BOUND_MS);
    capped(read.value?.issues);
    const write = await timed(() => files.writer().write(target, fresh, { confirmedLoosening: true }));
    expect(write.ms).toBeLessThan(BOUND_MS);
    if (write.value.kind === 'refused') capped(write.value.issues);
  }
  // Nothing the listing says grows with the file either.
  const listing = await timed(() => agent.run(call({ tool: 'config.read' }), ferretStanding));
  expect(listing.ms).toBeLessThan(BOUND_MS);
  capped(listing.value.issues);
}

describe('every declared kind, its own schema, wrong values at the size cap: every door within the bound', () => {
  for (const kind of KINDS) {
    const [label, text] = sweepTextOf(kind, CONFIG_FILE_MAX_BYTES);
    test(`T-0032 T-0033 T-0034 ${kind.path} (${label}): reload, read, validate and write each under ${BOUND_MS} ms`, async () => {
      await everyDoor(kind, text);
    });
  }
});

describe('review round 7: the real mcp/<name>.yaml at the size cap', () => {
  const mcp = KINDS.find(kind => kind.path === 'mcp/sweep.yaml');
  for (const [label, text] of mcpReviewShapes(CONFIG_FILE_MAX_BYTES)) {
    test(`T-0032 T-0033 T-0034 ${label}: every door under ${BOUND_MS} ms, at most ${MAX_CONFIG_ISSUES} problems listed`, async () => {
      if (mcp === undefined) throw new Error('mcp/<name>.yaml is not declared');
      await everyDoor(mcp, text);
    });
  }

  test('T-0033 an env of many wrong values: the first problems are located, the rest are one counted sentence', async () => {
    const mcp = KINDS.find(kind => kind.path === 'mcp/sweep.yaml') as DeclaredKind;
    const [, text] = mcpReviewShapes(CONFIG_FILE_MAX_BYTES)[0] as readonly [string, string];
    const { agent } = world(mcp);
    const answer = await agent.run(call({ tool: 'config.validate', path: mcp.path, text }), ferretStanding);
    const issues = answer.issues ?? [];
    expect(issues).toHaveLength(MAX_CONFIG_ISSUES + 1);
    // Each listed one at its own line, in file order: line 3 is the first entry under env.
    expect(issues.slice(0, 3).map(issue => issue.line)).toEqual([3, 4, 5]);
    const entries = text.split('\n').length - 3;
    expect(countProblems(issues)).toBe(entries);
    expect(issues.at(-1)?.message).toBe(`and ${String(entries - MAX_CONFIG_ISSUES)} more problems not listed here`);
    expect(issues.at(-1)?.line).toBeUndefined();
    expect(answer.summary).toContain(`${String(entries)} problems`);
    // The whole answer is a few KiB, not megabytes.
    expect(JSON.stringify(answer).length).toBeLessThan(32 * 1024);
  });

  test('a YAML 1.1 !!omap is not resolved: args reads as the plain list it is written as', async () => {
    const mcp = KINDS.find(kind => kind.path === 'mcp/sweep.yaml') as DeclaredKind;
    const { agent } = world(mcp);
    const answer = await agent.run(
      call({ tool: 'config.validate', path: mcp.path, text: 'command: x\nargs: !!omap [a: 1]\n' }),
      ferretStanding,
    );
    // A list of one mapping, not a Map: refused by the schema (args are strings), located at the item.
    expect(answer.issues?.[0]?.line).toBe(2);
    expect(answer.issues?.[0]?.message).toStartWith('args[0]');
  });
});
