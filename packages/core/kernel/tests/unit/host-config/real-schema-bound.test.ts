/**
 * Every configuration file kind this build declares, checked against its OWN schema on a hostile text: no answer lists
 * more than {@link MAX_CONFIG_ISSUES} problems and one sentence counting the rest, at every door a text comes in by -
 * `config_validate`, `config_write` and `config_read` for a file an agent may name, the owner's write and read
 * otherwise, and a reload of it hand-written. The text here is small; the same sweep at the size cap, with its CPU
 * bound per door, is `tests/perf/host-config/real-schema-bound.test.ts`. Boot is `../host/config-real-schema-boot.test.ts`.
 *
 * The kinds come from the generated registry: a plugin that declares a new file is swept here without being listed.
 */
import { describe, expect, test } from 'bun:test';
import { countProblems, MAX_CONFIG_ISSUES } from '../../../host/config/check.ts';
import { CONFIG_FILE_MAX_BYTES, configTextTooLarge } from '@ferretry/std/yaml';
import { type DeclaredKind, mcpReviewShapes, sweepTextOf } from './real-schemas.ts';
import { call, everyDoor, ferretStanding, KINDS, UNTIMED, world } from './real-schema-doors.ts';

/** Small enough that the sweep is instant; the mcp shapes below still list more than the cap. */
const SMALL_BYTES = 16 * 1024;

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

describe('every declared kind, its own schema, wrong values: every door answers capped', () => {
  for (const kind of KINDS) {
    const [label, text] = sweepTextOf(kind, SMALL_BYTES);
    test(`T-0032 T-0033 T-0034 ${kind.path} (${label}): reload, read, validate and write answer within the issue cap`, async () => {
      await everyDoor(kind, text, UNTIMED);
    });
  }
});

describe('review round 7: the real mcp/<name>.yaml', () => {
  const mcp = KINDS.find(kind => kind.path === 'mcp/sweep.yaml');
  for (const [label, text] of mcpReviewShapes(SMALL_BYTES)) {
    test(`T-0032 T-0033 T-0034 ${label}: every door answers, at most ${MAX_CONFIG_ISSUES} problems listed`, async () => {
      if (mcp === undefined) throw new Error('mcp/<name>.yaml is not declared');
      await everyDoor(mcp, text, UNTIMED);
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
