import { describe, expect, test } from 'bun:test';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { installedHarnesses } from '../../../daemon/lib/harnesses.ts';

/** A registry stand-in: the keys it lists, and the display name each one's facts give (`undefined`: no facts). */
const registry = (names: Readonly<Record<string, string | undefined>>, fails = false) =>
  ({
    harnesses: () => {
      if (fails) throw new Error('the registry is not ready');
      return Object.keys(names);
    },
    harnessFacts: (key: string) => (names[key] === undefined ? undefined : { displayName: names[key] }),
  }) as unknown as Pick<FerretsApi, 'harnesses' | 'harnessFacts'>;

describe('the harnesses installed on this machine', () => {
  test("are the registry's keys, each with the name its own facts give, in registry order", () => {
    expect(
      installedHarnesses(registry({ codex: 'Codex', 'claude-code': 'Claude Code', 'fake-third': 'Fake Third' })),
    ).toEqual([
      { key: 'codex', label: 'Codex' },
      { key: 'claude-code', label: 'Claude Code' },
      { key: 'fake-third', label: 'Fake Third' },
    ]);
  });

  test('leave out a key whose facts the registry cannot give: it cannot be named to a person', () => {
    expect(installedHarnesses(registry({ codex: 'Codex', ghost: undefined }))).toEqual([
      { key: 'codex', label: 'Codex' },
    ]);
  });

  test('are none when Ferrets is off or its registry cannot answer', () => {
    expect(installedHarnesses(undefined)).toEqual([]);
    expect(installedHarnesses(registry({ codex: 'Codex' }, true))).toEqual([]);
  });
});
