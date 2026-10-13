import { describe, expect, it } from 'bun:test';
import { FleetAccountChangeSchema } from '@ferretry/protocol';
import {
  BUILD_PROFILE_FLOW_KIND,
  BUILD_STEPS,
  buildProfileFlowInput,
  draftFromProfile,
  draftLayers,
  emptyProfileDraft,
  includedBy,
  moveBase,
  parseLayer,
  partCount,
  profileChange,
  profileNameProblem,
  runtimesReaching,
  stackConflicts,
  toggleBase,
  togglePick,
} from '../../../../../src/features/fleet/profiles/profile-model.ts';
import { CONFLICT, profile, profileCatalog, runtimeCatalog, stack } from '../components/catalog-fixture.ts';

const [agentWork, base, review] = profileCatalog().profiles as [
  ReturnType<typeof profile>,
  ReturnType<typeof profile>,
  ReturnType<typeof profile>,
];

describe('reading profiles', () => {
  it('parses a layer reference', () => {
    expect(parseLayer('profile/Default')).toEqual({ kind: 'profile', name: 'Default' });
    expect(parseLayer('mcp/github')).toEqual({ kind: 'component', componentKind: 'mcp', name: 'github' });
    expect(parseLayer('nothing')).toBeUndefined();
    expect(parseLayer('/x')).toBeUndefined();
    expect(parseLayer('widgets/x')).toBeUndefined();
  });

  it('names who builds on a profile and every runtime it reaches, saying through which profile', () => {
    expect(includedBy(base)).toEqual(['Agent work', 'Review']);
    expect(runtimesReaching(base, runtimeCatalog().runtimes)).toEqual([
      { runtime: 'claude-agent', through: 'Agent work' },
      { runtime: 'claude-default' },
      { runtime: 'claude-review', through: 'Review' },
    ]);
    expect(runtimesReaching(review, runtimeCatalog().runtimes)).toEqual([{ runtime: 'claude-review' }]);
  });

  it('counts the parts a profile flattens to', () => {
    expect(partCount(base)).toBe(4);
    expect(partCount({ ...base, harnesses: [] })).toBe(0);
  });

  it('lists each conflict once across both harnesses', () => {
    expect(stackConflicts(agentWork.harnesses)).toEqual([CONFLICT]);
    expect(stackConflicts([stack('claude')])).toEqual([]);
  });
});

describe('the Build a profile flow', () => {
  it('has eight steps and says what leaving loses', () => {
    expect(BUILD_STEPS.map(step => step.label)).toEqual([
      'Start from',
      'Instructions',
      'MCP',
      'Skills',
      'Settings',
      'Model set',
      'Review layers',
      'Name',
    ]);
    expect(buildProfileFlowInput()).toMatchObject({
      kind: BUILD_PROFILE_FLOW_KIND,
      title: 'Build a profile',
      leave: { consequence: 'No profile is created.', stopLabel: 'Stop, discard profile' },
    });
    expect(buildProfileFlowInput({ editing: 'Default', harness: 'codex' })).toMatchObject({
      title: 'Edit Default',
      leave: { consequence: 'Your changes to the layers are not saved.' },
    });
  });

  it('starts an edit from the profile and writes bases first, then components kind by kind', () => {
    const draft = draftFromProfile(profile('Mixed', ['mcp/a', 'profile/Base', 'hooks/h', 'instructions/i', 'bogus']));
    expect(draft.bases).toEqual(['Base']);
    expect(draftLayers(draft)).toEqual(['profile/Base', 'instructions/i', 'mcp/a', 'hooks/h']);
    expect(draft.name).toBe('Mixed');
  });

  it('ticks bases in order, the last one winning, and moves them', () => {
    let draft = toggleBase(emptyProfileDraft(), 'Default', true);
    draft = toggleBase(draft, 'Agent', true);
    expect(draft.bases).toEqual(['Default', 'Agent']);
    expect(moveBase(draft, 1, -1).bases).toEqual(['Agent', 'Default']);
    expect(moveBase(draft, 0, -1)).toBe(draft);
    expect(moveBase(draft, 1, 1)).toBe(draft);
    expect(toggleBase(draft, 'Default', false).bases).toEqual(['Agent']);
  });

  it('picks many of a kind, but one model set at most', () => {
    let draft = togglePick(emptyProfileDraft(), 'mcp', 'mcp/a', true);
    draft = togglePick(draft, 'mcp', 'mcp/b', true);
    expect(draft.picks.mcp).toEqual(['mcp/a', 'mcp/b']);
    expect(togglePick(draft, 'mcp', 'mcp/a', false).picks.mcp).toEqual(['mcp/b']);
    draft = togglePick(draft, 'modelSets', 'modelSets/x', true);
    draft = togglePick(draft, 'modelSets', 'modelSets/y', true);
    expect(draft.picks.modelSets).toEqual(['modelSets/y']);
    expect(togglePick(draft, 'modelSets', null, true).picks.modelSets).toEqual([]);
    expect(togglePick(draft, 'modelSets', 'modelSets/y', false).picks.modelSets).toEqual([]);
  });

  it('checks the name', () => {
    const profiles = profileCatalog().profiles;
    expect(profileNameProblem('  ', profiles)).toBe('Give the profile a name.');
    expect(profileNameProblem('a/b', profiles)).toBe('Use a name without a slash or "..".');
    expect(profileNameProblem('Default', profiles)).toBe('You already have a profile called Default.');
    expect(profileNameProblem('Default', profiles, 'Default')).toBeUndefined();
    expect(profileNameProblem('Docs', profiles)).toBeUndefined();
  });

  it('saves a new profile, or the edited one under its own name', () => {
    const draft = {
      ...togglePick(toggleBase(emptyProfileDraft(), 'Default', true), 'mcp', 'mcp/a', true),
      name: ' Docs ',
    };
    expect(FleetAccountChangeSchema.parse(profileChange(draft))).toEqual({
      kind: 'profile.put',
      name: 'Docs',
      layers: ['profile/Default', 'mcp/a'],
      create: true,
    });
    expect(profileChange(draft, 'Review')).toMatchObject({ name: 'Review', create: false });
  });
});
