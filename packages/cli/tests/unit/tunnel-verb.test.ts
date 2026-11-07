/**
 * The connections plugin's tunnel group, resolved by the shell's REAL verb table over the generated registry:
 * today's `fy daemon tunnel` shows the status (`isDefault: true`), and after the noun move `fy tunnel` must too.
 */
import { expect, it } from 'bun:test';
import { registry } from '../../src/generated/commands.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';

it('V-0245 a bare `tunnel` resolves to the connections plugin, and its subcommands still resolve to their own', () => {
  const table = buildVerbTable(registry);
  const bare = resolveVerb(table, ['tunnel']);
  expect(bare.kind === 'verb' && { line: bare.entry.line, owner: bare.entry.owner, rest: bare.rest }).toEqual({
    line: 'tunnel',
    owner: 'connections',
    rest: [],
  });
  const json = resolveVerb(table, ['tunnel', '--json']);
  expect(json.kind === 'verb' && { line: json.entry.line, rest: json.rest }).toEqual({
    line: 'tunnel',
    rest: ['--json'],
  });
  for (const sub of ['status', 'on', 'off']) {
    const resolved = resolveVerb(table, ['tunnel', sub]);
    expect(resolved.kind === 'verb' && resolved.entry.line).toBe(`tunnel ${sub}`);
  }
  expect(table.conflicts.filter(conflict => conflict.owner === 'connections')).toEqual([]);
});
