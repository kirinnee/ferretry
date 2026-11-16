import { describe, expect, test } from 'bun:test';
import { nixLines, detailLines, lockLines } from '../../cli/lib/render.ts';
import { ShellDetailSchema, ShellLockSchema } from '../../contract/index.ts';
import { HASH_A, HASH_B, REV_A, REV_B } from './support.ts';

const packagesLock = ShellLockSchema.parse({
  format: 1,
  name: 'tools',
  source: { kind: 'packages', packages: ['git', 'jq'], nixpkgs: { rev: REV_B, narHash: HASH_B } },
  resolvedAt: '2026-11-07T10:00:00.000Z',
  floating: false,
});
const flakeLock = ShellLockSchema.parse({
  format: 1,
  name: 'web',
  source: { kind: 'flake', ref: 'github:me/shells#web', rev: REV_A, narHash: HASH_A },
  resolvedAt: '2026-11-07T10:00:00.000Z',
  floating: false,
});

describe('the lines `fy shell` prints', () => {
  test('a package list names its packages and the nixpkgs it is pinned to', () => {
    expect(lockLines(packagesLock)).toEqual(['packages git, jq', `nixpkgs  ${REV_B}`, `narHash  ${HASH_B}`]);
  });
  test('a flake names its source, revision and hash', () => {
    expect(lockLines(flakeLock)).toEqual(['source   github:me/shells#web', `revision ${REV_A}`, `narHash  ${HASH_A}`]);
  });
  test('a detail with a package lock and a description shows both, then the state', () => {
    const detail = ShellDetailSchema.parse({
      name: 'tools',
      item: { packages: ['git', 'jq'], description: 'my tools', floating: true },
      lock: packagesLock,
      summary: { name: 'tools', kind: 'packages', locked: true, floating: true, build: 'not-built', usedBy: [] },
    });
    const lines = detailLines(detail);
    expect(lines.slice(0, 2)).toEqual(['shell    tools', 'my tools']);
    expect(lines.at(-1)).toBe('state    not built, floating');
  });
  test('nix being present says which version, and absent says what follows and what to do', () => {
    expect(nixLines({ present: true, version: '2.24.1', path: 'nix' })).toEqual([
      'nix 2.24.1 is installed; ferrets whose runtime names a shell work inside it',
    ]);
    expect(nixLines({ present: false, consequence: 'no shells', remedy: 'install nix' })).toEqual([
      'nix is not installed: no shells',
      'install nix',
    ]);
  });
});
