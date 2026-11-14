/**
 * Today's spellings for verbs the 5.0 split renamed (V-0232, V-0241, V-0245 … V-0248, V-0250, V-0436), resolved by the
 * shell's REAL verb table over the generated registry the way `run.ts` does it: an alias is re-resolved to the verb it
 * runs, with every later word handed on. They run the new verb and add nothing of their own.
 */
import { expect, it } from 'bun:test';
import { registry } from '../../src/generated/commands.ts';
import { buildVerbTable, expandAlias, resolveVerb, type VerbEntry } from '../../src/lib/verbs.ts';

const table = buildVerbTable(registry);

/** What `fy <typed…>` ends up running: the verb line, who owns it, and the words it is handed. */
function runs(typed: readonly string[]) {
  let tokens = typed;
  let resolved = resolveVerb(table, tokens);
  for (let hops = 0; resolved.kind === 'verb' && resolved.entry.alias !== undefined && hops < 4; hops += 1) {
    tokens = expandAlias(resolved.entry, resolved.rest) ?? tokens;
    resolved = resolveVerb(table, tokens);
  }
  if (resolved.kind !== 'verb') return undefined;
  const entry: VerbEntry = resolved.entry;
  return { line: entry.line, owner: entry.owner, rest: resolved.rest };
}

it('V-0245 fy daemon tunnel runs `fy tunnel`, the verb that replaced it', () => {
  expect(runs(['daemon', 'tunnel'])).toEqual({ line: 'tunnel', owner: 'connections', rest: [] });
});

it('V-0248 fy daemon tunnel status runs `fy tunnel status`, the verb that replaced it', () => {
  expect(runs(['daemon', 'tunnel', 'status'])).toEqual({ line: 'tunnel status', owner: 'connections', rest: [] });
});

it('V-0247 fy daemon tunnel on runs `fy tunnel on`, the verb that replaced it', () => {
  expect(runs(['daemon', 'tunnel', 'on'])).toEqual({ line: 'tunnel on', owner: 'connections', rest: [] });
});

it('V-0246 fy daemon tunnel off runs `fy tunnel off`, the verb that replaced it', () => {
  expect(runs(['daemon', 'tunnel', 'off'])).toEqual({ line: 'tunnel off', owner: 'connections', rest: [] });
});

it('V-0250 fy daemon update --check --json runs `fy update`, the verb that replaced it', () => {
  expect(runs(['daemon', 'update', '--check', '--json'])).toEqual({
    line: 'update',
    owner: 'shell',
    rest: ['--check', '--json'],
  });
});

it('V-0241 fy daemon setup runs `fy onboard`, the verb that replaced it', () => {
  expect(runs(['daemon', 'setup'])).toEqual({ line: 'onboard', owner: 'onboarding', rest: [] });
});

it('V-0436 fy setup --yes --check runs `fy onboard`, the verb that replaced it', () => {
  expect(runs(['setup', '--yes', '--check'])).toEqual({
    line: 'onboard',
    owner: 'onboarding',
    rest: ['--yes', '--check'],
  });
});

it('V-0232 fy daemon import claude runs `fy runtime link`, the verb that replaced it', () => {
  expect(runs(['daemon', 'import', 'claude'])).toEqual({ line: 'runtime link', owner: 'runtimes', rest: ['claude'] });
});

it('the old spellings are the shell’s own, add no verb conflict, and leave the new verbs where they were', () => {
  expect(table.conflicts).toEqual([]);
  for (const old of ['daemon tunnel', 'daemon update', 'daemon setup', 'daemon import', 'setup'])
    expect(table.entries.find(entry => entry.line === old)).toMatchObject({ owner: 'shell' });
  expect(runs(['tunnel', 'status'])).toMatchObject({ line: 'tunnel status', owner: 'connections' });
  expect(runs(['update'])).toMatchObject({ line: 'update', owner: 'shell' });
  expect(runs(['onboard'])).toMatchObject({ line: 'onboard', owner: 'onboarding' });
});
