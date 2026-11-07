import { describe, expect, test } from 'bun:test';
import { shellLoosens, ShellItemSchema } from '../../contract/index.ts';
import { fakeShells, shellsConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

describe('shells contract', () => {
  test('the fake passes the conformance suite', async () => {
    expect((await shellsConformance(fakeShells)).ok).toBe(true);
  });

  test('every route that writes a source or runs a build is a person act on fleet.configure', () => {
    const writes = manifest.actions.routes.filter(
      route => route.method !== 'GET' && route.path !== '/v1/shells/preview',
    );
    expect(writes.length).toBe(4);
    for (const route of writes) {
      expect(route.caller).toBe('person');
      expect(route.capability?.axis).toBe('configure');
    }
  });

  test('a shell is a flake or a package list, never both and never neither', () => {
    expect(ShellItemSchema.safeParse({ flake: 'github:me/shells/0123#web' }).success).toBe(true);
    expect(ShellItemSchema.safeParse({ packages: ['git'] }).success).toBe(true);
    expect(ShellItemSchema.safeParse({}).success).toBe(false);
    expect(ShellItemSchema.safeParse({ flake: 'x', packages: ['git'] }).success).toBe(false);
  });

  test('a new, changed or newly floating shell is held for the owner', () => {
    const item = ShellItemSchema.parse({ packages: ['git'] });
    expect(shellLoosens(undefined, item).length).toBe(1);
    expect(shellLoosens(item, item)).toEqual([]);
    expect(shellLoosens(item, { ...item, floating: true }).length).toBe(1);
    expect(shellLoosens(item, { ...item, packages: ['git', 'jq'] }).length).toBe(1);
  });
});
