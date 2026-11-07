import { describe, it } from 'bun:test';
import should from 'should';
import { renderModelSet, renderModelSetList } from '../../../../cli/lib/model-set/commands.ts';
import { component, fakeWorld, modelSet, runVerb } from '../fleet/account-fakes.ts';
import type { ComponentCatalog } from '../../../../contract/index.ts';

const catalog = (): ComponentCatalog => ({
  format: 'present',
  kinds: [
    { kind: 'instructions', label: 'Instructions', description: 'd', components: [component()] },
    { kind: 'modelSets', label: 'Model sets', description: 'd', components: [modelSet()] },
  ],
});

describe('model set renderings', () => {
  it('should show the models, where it is used, and why it cannot be removed', () => {
    const text = renderModelSet(
      modelSet({ remove: { available: false, reason: '1 profile uses it.' }, warnings: ['mythos is slow today'] }),
    );
    should(text).match(/^modelSets\/heavy\n {2}Models: opus, sonnet\n {2}Starts with: opus/);
    should(text)
      .match(/Note: mythos is slow today/)
      .and.match(/Used by profiles: default/)
      .and.match(/Used by runtimes: claude-default/)
      .and.match(/Cannot remove yet: 1 profile uses it\./);
  });

  it('should list model sets, and say how to add the first', () => {
    should(renderModelSetList([modelSet()], 'fz')).match(
      /^heavy {2}opus, sonnet {2}used by 1 profile\(s\)\n\nShow one with `fz model-set show <name>`\./,
    );
    should(renderModelSetList([], 'fz')).match(/fz model-set add/);
  });
});

describe('model-set verbs', () => {
  const known = { gateway: { components: catalog } };

  it('should list only the model sets, as words or JSON', async () => {
    const world = fakeWorld(known);
    await runVerb(world, 'model-set ls');
    await runVerb(world, 'model-set ls', [], { json: true });
    should(world.out.lines[0]?.text)
      .match(/^heavy/)
      .and.not.match(/main/);
    should(JSON.parse(world.out.lines[1]?.text as string).kinds.map((group: { kind: string }) => group.kind)).eql([
      'modelSets',
    ]);
  });

  it('should show one, or refuse a name it does not have', async () => {
    const world = fakeWorld(known);
    await runVerb(world, 'model-set show', ['heavy']);
    should(world.out.lines[0]?.text).match(/^modelSets\/heavy/);
    await should(runVerb(world, 'model-set show', ['nope'])).be.rejectedWith(/fz model-set ls/);
  });

  it('should add one without asking, the first model being the default unless one is named', async () => {
    const world = fakeWorld();
    await runVerb(world, 'model-set add', ['light'], { model: ['haiku', 'sonnet'] });
    await runVerb(world, 'model-set add', ['other'], { model: ['a', 'b'], default: 'b' });
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      {
        kind: 'component.put',
        name: 'light',
        component: { kind: 'modelSets', models: ['haiku', 'sonnet'], default: 'haiku' },
        create: true,
      },
      {
        kind: 'component.put',
        name: 'other',
        component: { kind: 'modelSets', models: ['a', 'b'], default: 'b' },
        create: true,
      },
    ]);
    should(world.prompt.questions).be.empty();
  });

  it('should refuse a model set with no model, or a default that is not one of them', async () => {
    const world = fakeWorld();
    await should(runVerb(world, 'model-set add', ['empty'])).be.rejectedWith(/at least one --model/);
    await should(runVerb(world, 'model-set add', ['bad'], { model: 'a', default: 'z' })).be.rejectedWith(
      /--default must be one of them/,
    );
    should(world.gateway.called('stage')).be.empty();
  });

  it('should edit what was named and keep the rest, after a yes', async () => {
    const world = fakeWorld({ ...known, answers: ['y', 'y'] });
    await runVerb(world, 'model-set edit', ['heavy'], { default: 'sonnet' });
    await runVerb(world, 'model-set edit', ['heavy'], { model: ['opus', 'haiku'] });
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      {
        kind: 'component.put',
        name: 'heavy',
        component: { kind: 'modelSets', models: ['opus', 'sonnet'], default: 'sonnet' },
        create: false,
      },
      {
        kind: 'component.put',
        name: 'heavy',
        component: { kind: 'modelSets', models: ['opus', 'haiku'], default: 'opus' },
        create: false,
      },
    ]);
    await should(runVerb(world, 'model-set edit', ['nope'], { model: 'a' })).be.rejectedWith(/model-set add nope/);
  });

  it('should remove one under --yes, taking it out of profiles first only when told to', async () => {
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'model-set rm', ['heavy'], { yes: true });
    await runVerb(world, 'model-set rm', ['heavy'], { yes: true, 'remove-from-profiles': true });
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'component.remove', componentKind: 'modelSets', name: 'heavy' },
      { kind: 'component.remove', componentKind: 'modelSets', name: 'heavy', removeFromProfiles: true },
    ]);
  });
});
