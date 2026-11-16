import { describe, expect, it } from 'bun:test';
import { addRequestOf, packageNames, shellLine } from '../../../app/lib/shells-model.ts';

describe('the Shells tab model', () => {
  it('splits package names on spaces and commas', () => {
    expect(packageNames('git, jq  bun\nripgrep')).toEqual(['git', 'jq', 'bun', 'ripgrep']);
  });

  it('makes a package-list request, a flake request, or says what is missing', () => {
    expect(addRequestOf({ name: 'web', kind: 'packages', source: 'git jq', floating: true })).toEqual({
      ok: true,
      request: { name: 'web', item: { packages: ['git', 'jq'], floating: false } },
    });
    expect(addRequestOf({ name: 'web', kind: 'flake', source: ' github:me/shells#web ', floating: true })).toEqual({
      ok: true,
      request: { name: 'web', item: { flake: 'github:me/shells#web', floating: true } },
    });
    expect(addRequestOf({ name: 'Web', kind: 'flake', source: 'x', floating: false }).ok).toBe(false);
    expect(addRequestOf({ name: 'web', kind: 'packages', source: ' ', floating: false }).ok).toBe(false);
  });

  it('says what a shell is, whether it is pinned and who uses it', () => {
    expect(
      shellLine({ name: 'web', kind: 'flake', locked: true, floating: false, build: 'built', usedBy: ['claude'] }),
    ).toBe('Flake reference · locked · used by claude');
    expect(
      shellLine({ name: 'web', kind: 'packages', locked: false, floating: false, build: 'not-built', usedBy: [] }),
    ).toBe('Package list · not locked · used by nothing yet');
  });
});
