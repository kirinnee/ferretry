import { describe, expect, test } from 'bun:test';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import type { SharedTree } from '@ferretry/kernel/contract';
import type { FerretSkillsInventory, SkillEntry, SkillsItem } from '../../contract/index.ts';
import { composerSkills } from '../../daemon/lib/composer.ts';
import { skillParts } from '../../daemon/lib/launch-parts.ts';

const items = new Map<string, SkillsItem>([
  ['all', { items: ['alpha', 'beta'] }],
  ['codex-only', { items: ['gamma'], harness: 'codex' }],
]);
const trees = new Map<string, SharedTree>([
  ['alpha', { shared: 'alpha' } as unknown as SharedTree],
  ['gamma', { shared: 'gamma' } as unknown as SharedTree],
]);
const resolve = async (name: string) => trees.get(name);
const names = (parts: readonly LaunchPart[]) => parts.map(part => part.kind === 'skill' && part.name);

const both = new Set(['all', 'codex-only']);

describe('skills launch parts', () => {
  test('F-0184 one skill part per installed folder an item names, for the harnesses it allows, skipping a folder the store lacks', async () => {
    const parts = await skillParts(items, 'claude-code', resolve, both);
    expect(parts).toEqual([{ kind: 'skill', name: 'alpha', tree: trees.get('alpha') as SharedTree }]);
    expect(names(await skillParts(items, 'codex', resolve, both))).toEqual(['alpha', 'gamma']);
  });

  test('F-0184 a part carries the shared folder and never a path', async () => {
    for (const part of await skillParts(items, 'codex', resolve, both)) expect(part).not.toHaveProperty('path');
  });

  test('F-0184 a folder named by two items is added once', async () => {
    const twice = new Map<string, SkillsItem>([
      ['a', { items: ['alpha'] }],
      ['b', { items: ['alpha'] }],
    ]);
    expect(await skillParts(twice, 'codex', resolve, new Set(['a', 'b']))).toHaveLength(1);
  });

  test('D10 a launch carries only the items its runtime’s profile selects', async () => {
    expect(names(await skillParts(items, 'codex', resolve, new Set(['codex-only'])))).toEqual(['gamma']);
    expect(await skillParts(items, 'codex', resolve, new Set())).toEqual([]);
    expect(names(await skillParts(items, 'codex', resolve, new Set(['not-an-item'])))).toEqual([]);
  });
});

const skill = (name: string, scope: SkillEntry['scope']): SkillEntry => ({
  name,
  description: `does ${name}`,
  harness: 'claude-code',
  scope,
  path: `/x/${name}/SKILL.md`,
  runtimes: [],
});

describe('the composer list', () => {
  test('a project skill replaces a global one of the same name, and the list is sorted', () => {
    const inventory: FerretSkillsInventory = {
      ferretId: 'f1',
      harness: 'claude-code',
      folder: '/work/app',
      truncated: false,
      skills: [skill('b', 'user'), skill('a', 'ferretry'), skill('b', 'project')],
    };
    const listed = composerSkills(inventory);
    expect(listed.skills.map(entry => [entry.name, entry.scope, entry.origin])).toEqual([
      ['a', 'global', 'claude-code'],
      ['b', 'project', 'claude-code'],
    ]);
  });
});
