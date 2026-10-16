import { describe, it } from 'bun:test';
import should from 'should';
import { registerProfileCommands, renderProfile, renderProfileList } from '../../../src/lib/profile/commands.ts';
import { fakeWorld, profile, runCommand, stack } from '../fleet/account-fakes.ts';

const layered = profile({
  name: 'agent-work',
  scope: { kind: 'scoped', scope: 'claude' },
  layers: ['profile/default', 'settings/agent'],
  usedBy: [],
  baseFor: ['later'],
  harnesses: [
    stack({
      conflicts: [
        {
          harness: 'claude',
          field: 'env',
          key: 'X',
          sentence: 'X: 2 overrides 1',
          winner: 'settings/agent',
          overridden: ['profile/default'],
        },
      ],
    }),
  ],
  remove: { available: false, reason: '1 profile is built on it.' },
});

describe('profile renderings', () => {
  it('should list profiles with their layer and override counts', () => {
    const text = renderProfileList({ format: 'version-2', profiles: [profile(), layered] }, 'fz');
    should(text).match(/^default {2}Generic · 1 layer\n {2}Used by: claude-default/);
    should(text).match(/agent-work {2}Claude only · 2 layers · 1 override\n {2}Used by: no runtime/);
  });

  it('should flag a profile mixed before P7 with the sentence naming its layers', () => {
    const sentence =
      "Profile default can't be both Claude only and Codex only: settings a is Claude only and settings b is Codex only.";
    const mixed = profile({ scope: { kind: 'mixed', sentence } });
    should(renderProfileList({ format: 'version-2', profiles: [mixed] }, 'fz')).match(
      /^default {2}Mixed · 1 layer\n {2}Used by: claude-default\n {2}Profile default can't/,
    );
    should(renderProfile(mixed)).match(/^default {2}\(Mixed\)\n {2}Profile default can't/);
    should(renderProfile(profile({ scope: { kind: 'scoped', scope: 'codex' } }))).match(/^default {2}\(Codex only\)/);
  });

  it('should say how to build the first profile', () => {
    should(renderProfileList({ format: 'version-2', profiles: [] }, 'fz')).match(/fz profile build/);
  });

  it('should show layers, each tool, where it is used and why it cannot be deleted', () => {
    const text = renderProfile(layered);
    should(text).match(/Layers, oldest first \(a later layer wins\):\n {4}profile\/default\n {4}settings\/agent/);
    should(text)
      .match(/Base for: later/)
      .and.match(/On Claude Code:/)
      .and.match(/Overrides: X: 2 overrides 1/);
    should(text).match(/Cannot delete yet: 1 profile is built on it\./);
    should(renderProfile(profile())).not.match(/Base for|Cannot delete/);
  });
});

describe('registerProfileCommands', () => {
  it('should list and show profiles, as words or JSON', async () => {
    const world = fakeWorld({ gateway: { profiles: () => ({ format: 'version-2', profiles: [profile()] }) } });
    await runCommand(registerProfileCommands, world, ['profiles']);
    await runCommand(registerProfileCommands, world, ['profiles', '--json']);
    await runCommand(registerProfileCommands, world, ['profile', 'show', 'default']);
    await runCommand(registerProfileCommands, world, ['profile', 'show', 'default', '--json']);
    await runCommand(registerProfileCommands, world, ['profile', 'ls']);
    await runCommand(registerProfileCommands, world, ['profile', 'list', '--json']);
    should(world.out.lines.map(line => line.text.slice(0, 7))).eql([
      'default',
      '{\n  "fo',
      'default',
      '{\n  "na',
      'default',
      '{\n  "fo',
    ]);
    should(world.out.lines[4]?.text).match(/^default {2}Generic · 1 layer/);
    await should(runCommand(registerProfileCommands, world, ['profile', 'show', 'nope'])).be.rejectedWith(
      /fz profiles/,
    );
  });

  it('should build a profile from its layers in order', async () => {
    const world = fakeWorld();
    await runCommand(registerProfileCommands, world, [
      'profile',
      'build',
      'agent',
      '--layer',
      'profile/default',
      '--layer',
      'settings/agent',
    ]);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'profile.put',
      name: 'agent',
      layers: ['profile/default', 'settings/agent'],
      create: true,
    });
    await should(runCommand(registerProfileCommands, world, ['profile', 'build', 'empty'])).be.rejectedWith(
      /at least one layer/,
    );
  });

  it('should edit and delete only after a yes', async () => {
    const world = fakeWorld({ answers: ['yes', 'y'] });
    await runCommand(registerProfileCommands, world, ['profile', 'edit', 'agent', '--layer', 'settings/agent']);
    await runCommand(registerProfileCommands, world, ['profile', 'rm', 'agent', '--switch-runtimes-to', 'default']);
    await runCommand(registerProfileCommands, world, ['profile', 'rm', 'other', '--yes']);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'profile.put', name: 'agent', layers: ['settings/agent'], create: false },
      { kind: 'profile.remove', name: 'agent', switchRuntimesTo: 'default' },
      { kind: 'profile.remove', name: 'other' },
    ]);
    should(world.gateway.called('apply')).have.length(3);
  });
});
