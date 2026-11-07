import { describe, expect, it } from 'bun:test';
import { FleetAccountChangeSchema, type FleetResolvedEntry } from '@ferretry/protocol';
import {
  addRefusal,
  contentScope,
  filterLibrary,
  includedBy,
  insertAt,
  itemFor,
  itemName,
  libraryItems,
  moveBefore,
  moveBy,
  overrideChips,
  type ProfileItem,
  parseItem,
  partCount,
  profileChange,
  profileNameProblem,
  profileUseLine,
  removeAt,
  resolvedHarnesses,
  runtimesReaching,
  sameContents,
  scopeWord,
} from '../../../../../src/features/fleet/profiles/profile-model.ts';
import { profile, profileCatalog, runtimeCatalog, studioCatalog } from '../components/catalog-fixture.ts';

const [, base, review] = profileCatalog().profiles as [
  ReturnType<typeof profile>,
  ReturnType<typeof profile>,
  ReturnType<typeof profile>,
];

const item = (reference: string, scope: ProfileItem['scope'] = 'generic'): ProfileItem => ({
  reference,
  ...parseItem(reference),
  scope,
});

describe('reading items', () => {
  it('reads a reference as a profile, a component of a known kind, or text as written', () => {
    expect(parseItem('profile/Default')).toEqual({ kind: 'profile', name: 'Default' });
    expect(parseItem('mcp/github')).toEqual({ kind: 'mcp', name: 'github' });
    expect(parseItem('widgets/x')).toEqual({ kind: 'unknown', name: 'widgets/x' });
    expect(parseItem('/x')).toEqual({ kind: 'unknown', name: '/x' });
    expect(itemName('modelSets/Claude models')).toBe('Claude models');
  });

  it('builds the library from every component and every profile but the one being edited', () => {
    const library = libraryItems(studioCatalog(), 'Default');
    expect(library.map(each => each.reference)).toEqual([
      'instructions/Main instructions',
      'mcp/github',
      'mcp/notes',
      'skills/My skills',
      'settings/Claude settings',
      'hooks/Format on save',
      'modelSets/Claude models',
      'profile/Agent work',
      'profile/Review',
    ]);
    expect(library.find(each => each.reference === 'settings/Claude settings')?.scope).toBe('claude');
    expect(libraryItems(studioCatalog()).some(each => each.reference === 'profile/Default')).toBe(true);
    const mixed = libraryItems(
      studioCatalog({ profiles: profileCatalog([profile('Old', [], { scope: { kind: 'mixed', sentence: 'x' } })]) }),
    );
    expect(mixed.at(-1)).toEqual({ reference: 'profile/Old', kind: 'profile', name: 'Old', scope: 'mixed' });
  });

  it('filters the library by name, by kind word and by the kind menu', () => {
    const library = libraryItems(studioCatalog());
    expect(filterLibrary(library, 'GIT', 'all').map(each => each.name)).toEqual(['github']);
    expect(filterLibrary(library, 'mcp', 'all').map(each => each.name)).toEqual(['github', 'notes']);
    expect(filterLibrary(library, '', 'profile').map(each => each.name)).toEqual(['Agent work', 'Default', 'Review']);
    expect(filterLibrary(library, 'nothing', 'all')).toEqual([]);
    expect(filterLibrary(library, '  ', 'all')).toHaveLength(library.length);
  });

  it('shows an item the library does not know as written, generic', () => {
    expect(itemFor('mcp/ghost', [])).toEqual({ reference: 'mcp/ghost', kind: 'mcp', name: 'ghost', scope: 'generic' });
    expect(itemFor('mcp/github', libraryItems(studioCatalog())).name).toBe('github');
  });
});

describe('scope from the contents', () => {
  it('is Generic until an item narrows it, and Mixed when both tools or a mixed profile are in', () => {
    expect(contentScope([item('mcp/a')])).toEqual({ scope: 'generic', because: [] });
    expect(contentScope([item('mcp/a'), item('settings/c', 'claude')]).scope).toBe('claude');
    expect(contentScope([item('settings/x', 'codex')]).scope).toBe('codex');
    expect(contentScope([item('settings/c', 'claude'), item('settings/x', 'codex')]).scope).toBe('mixed');
    expect(contentScope([item('profile/old', 'mixed')]).because.map(each => each.name)).toEqual(['old']);
    expect(scopeWord('mixed')).toBe('Mixed');
    expect(scopeWord('codex')).toBe('Codex only');
  });

  it('refuses an item already there, one that would contain itself, and a mix — naming the culprits', () => {
    const contents = [item('mcp/github'), item('settings/c', 'claude'), item('modelSets/m', 'claude')];
    const refuse = (candidate: ProfileItem, loops: string[] = [], name = 'Agent') =>
      addRefusal({ profile: name, contents, item: candidate, loops });
    expect(refuse(item('mcp/github'))).toBe('github is already in Agent.');
    expect(refuse(item('profile/Agent'))).toBe(
      'Agent can’t go in Agent: it already contains Agent, so Agent would contain itself.',
    );
    expect(refuse(item('profile/Agent work'), ['Agent work'])).toContain('Agent work can’t go in Agent');
    expect(refuse(item('settings/x', 'codex'))).toBe(
      'Refused: x is Codex only, but Agent is Claude only because of c and m. A profile can’t mix Claude-only and Codex-only content.',
    );
    expect(refuse(item('profile/old', 'mixed'))).toBe(
      'Refused: old mixes Claude-only and Codex-only content, so it can’t go in a profile.',
    );
    expect(refuse(item('settings/c2', 'claude'))).toBeUndefined();
    expect(refuse(item('mcp/notes'))).toBeUndefined();
    expect(refuse(item('mcp/github'), [], '')).toBe('github is already in this profile.');
  });

  it('refuses the other tool’s item in a profile built for one login', () => {
    const refused = addRefusal({
      profile: '',
      contents: [],
      item: item('settings/x', 'codex'),
      loops: [],
      harness: 'claude',
    });
    expect(refused).toBe('Refused: x is Codex only, but this profile is for a Claude Code login.');
    expect(
      addRefusal({ profile: '', contents: [], item: item('settings/c', 'claude'), loops: [], harness: 'claude' }),
    ).toBeUndefined();
  });
});

describe('moving items', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('inserts once, at a clamped position', () => {
    expect(insertAt(list, 'x', 1)).toEqual(['a', 'x', 'b', 'c', 'd']);
    expect(insertAt(list, 'x', 99)).toEqual([...list, 'x']);
    expect(insertAt(list, 'x', -3)).toEqual(['x', ...list]);
    expect(insertAt(list, 'c', 0)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a dragged row to land before the row it was dropped on', () => {
    expect(moveBefore(list, 0, 2)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveBefore(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveBefore(list, 1, 4)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveBefore(list, 9, 0)).toBe(list);
  });

  it('moves one place with ↑ / ↓, and nothing at either end', () => {
    expect(moveBy(list, 1, -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveBy(list, 1, 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveBy(list, 0, -1)).toBe(list);
    expect(moveBy(list, 3, 1)).toBe(list);
    expect(moveBy(list, -1, 1)).toBe(list);
    expect(removeAt(list, 1)).toEqual(['a', 'c', 'd']);
    expect(sameContents(list, [...list])).toBe(true);
    expect(sameContents(list, ['a'])).toBe(false);
    expect(sameContents(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});

const entry = (overrides: Partial<FleetResolvedEntry>): FleetResolvedEntry => ({
  harness: 'claude',
  field: 'settings',
  key: 'permissions.defaultMode',
  value: 'acceptEdits',
  from: 'settings/Agent',
  overridden: [],
  ...overrides,
});

describe('what overrides what', () => {
  it('chips the later item once per key and earlier item, across both tools, never within one item', () => {
    const resolved = [
      entry({ overridden: [{ value: 'plan', from: 'profile/Default' }] }),
      entry({ harness: 'codex', overridden: [{ value: 'plan', from: 'profile/Default' }] }),
      entry({ key: 'model', field: 'model', from: 'modelSets/b', overridden: [{ value: 'x', from: 'modelSets/b' }] }),
      entry({ key: 'theme', overridden: [] }),
    ];
    const chips = overrideChips(resolved);
    expect(chips.get('settings/Agent')).toEqual([{ over: 'profile/Default', key: 'permissions.defaultMode' }]);
    expect(chips.has('modelSets/b')).toBe(false);
  });

  it('shows the profile’s own tool in Resolved, or each tool a Generic one resolves for', () => {
    expect(resolvedHarnesses('codex', [])).toEqual(['codex']);
    expect(resolvedHarnesses('generic', [entry({}), entry({ harness: 'codex' })])).toEqual(['claude', 'codex']);
    expect(resolvedHarnesses('generic', [entry({ harness: 'codex' })])).toEqual(['codex']);
    expect(resolvedHarnesses('mixed', [])).toEqual(['claude']);
  });
});

describe('saving and where a profile is used', () => {
  it('saves the whole list as one profile.put', () => {
    const change = profileChange(' Docs ', ['profile/Default', 'mcp/github'], true);
    expect(change).toEqual({
      kind: 'profile.put',
      name: 'Docs',
      layers: ['profile/Default', 'mcp/github'],
      create: true,
    });
    expect(FleetAccountChangeSchema.parse(change)).toEqual(change);
  });

  it('asks for a usable, unused name', () => {
    const profiles = profileCatalog().profiles;
    expect(profileNameProblem('  ', profiles)).toBe('Give the profile a name.');
    expect(profileNameProblem('a/b', profiles)).toBe('Use a name without a slash or "..".');
    expect(profileNameProblem('Default', profiles)).toBe('You already have a profile called Default.');
    expect(profileNameProblem('Docs', profiles)).toBeUndefined();
  });

  it('names who contains a profile and every runtime it reaches, saying through which profile', () => {
    expect(includedBy(base)).toEqual(['Agent work', 'Review']);
    expect(runtimesReaching(base, runtimeCatalog().runtimes)).toEqual([
      { runtime: 'claude-agent', through: 'Agent work' },
      { runtime: 'claude-default' },
      { runtime: 'claude-review', through: 'Review' },
    ]);
    expect(runtimesReaching(review, runtimeCatalog().runtimes)).toEqual([{ runtime: 'claude-review' }]);
  });

  it('counts its items and parts in the list line', () => {
    expect(partCount(base)).toBe(4);
    expect(partCount({ ...base, harnesses: [] })).toBe(0);
    expect(profileUseLine(base, 3)).toBe('4 items · 4 parts · used by 3 runtimes');
    expect(profileUseLine(review, 1)).toBe('2 items · 1 part · used by 1 runtime');
    expect(profileUseLine({ ...base, harnesses: [] }, 0)).toBe('4 items · 0 parts · not used yet');
  });
});
