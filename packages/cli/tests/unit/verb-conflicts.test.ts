import { expect, test } from 'bun:test';
import { registry } from '../../src/generated/commands.ts';
import { buildVerbTable, type VerbConflict } from '../../src/lib/verbs.ts';

/**
 * Verb clashes known and owned elsewhere, each with the change that removes it. A pair should leave this list in the
 * branch that drops the clash; a NEW clash fails below. Keyed `owner ← keptFrom: line` (the owner left out ← the one kept).
 */
const KNOWN_PENDING: Readonly<Record<string, string>> = {};

const keyOf = (conflict: VerbConflict): string => `${conflict.owner} ← ${conflict.keptFrom}: ${conflict.line}`;

test('no two plugins (or a plugin and the shell) declare the same CLI verb in the compiled registry', () => {
  // `buildVerbTable` keeps the first holder and silently leaves the other out of `fy`; only `fy doctor` would say so.
  const { conflicts } = buildVerbTable(registry);
  const unexpected = conflicts.map(keyOf).filter(key => KNOWN_PENDING[key] === undefined);
  expect(unexpected).toEqual([]);
});
