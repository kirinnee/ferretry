import { describe, expect, test } from 'bun:test';
import type { FencedPath } from '@ferretry/kernel/contract';
import type { FerretSkillsInventory, SkillEntry, SkillsItem } from '../../contract/index.ts';
import { composerSkills } from '../../daemon/lib/composer.ts';
import { skillParts } from '../../daemon/lib/launch-parts.ts';

const items = new Map<string, SkillsItem>([
  ['all', { items: ['alpha', 'beta'] }],
  ['codex-only', { items: ['gamma'], harness: 'codex' }],
]);
const folders = new Map<string, FencedPath>([
  ['alpha', '/store/alpha' as FencedPath],
  ['gamma', '/store/gamma' as FencedPath],
]);

describe('skills launch parts', () => {
  test('one skill part per folder an item names, for the harnesses it allows, skipping a folder the store lacks', () => {
    const parts = skillParts(items, 'claude-code', name => folders.get(name));
    expect(parts).toEqual([{ kind: 'skill', name: 'alpha', path: folders.get('alpha') as FencedPath }]);
    expect(
      skillParts(items, 'codex', name => folders.get(name)).map(part => part.kind === 'skill' && part.name),
    ).toEqual(['alpha', 'gamma']);
  });

  test('a folder named by two items is added once', () => {
    const twice = new Map<string, SkillsItem>([
      ['a', { items: ['alpha'] }],
      ['b', { items: ['alpha'] }],
    ]);
    expect(skillParts(twice, 'codex', name => folders.get(name))).toHaveLength(1);
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
