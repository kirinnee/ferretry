import { describe, it } from 'bun:test';
import type { FleetComponentCatalog } from '@ferretry/protocol';
import should from 'should';
import { componentInput, parseReference, registerComponentCommands } from '../../../src/lib/component/commands.ts';
import { renderComponent, renderComponentCatalog } from '../../../src/lib/component/render.ts';
import { component, fakeWorld, runCommand } from '../fleet/account-fakes.ts';

const mcp = component({
  reference: 'mcp/github',
  kind: 'mcp',
  name: 'github',
  detail: {
    kind: 'mcp',
    command: 'npx',
    args: ['-y', 'server'],
    url: 'https://mcp.example.com',
    env: [
      { name: 'TOKEN', hidden: true },
      { name: 'MODE', value: 'fast' },
    ],
  },
  partial: [{ harness: 'codex', reason: 'no url servers' }],
  warnings: ['Command not found: npx'],
  remove: { available: false, reason: 'default uses it.' },
});
const settings = component({
  reference: 'settings/agent',
  kind: 'settings',
  name: 'agent',
  harness: 'claude',
  detail: {
    kind: 'settings',
    file: 'components/settings/agent.json',
    flags: ['--verbose'],
    env: [{ name: 'A', value: '1' }],
  },
});
const skills = component({
  reference: 'skills/mine',
  kind: 'skills',
  name: 'mine',
  detail: { kind: 'skills', items: ['a', 'b'] },
});
const hooks = component({
  reference: 'hooks/fmt',
  kind: 'hooks',
  name: 'fmt',
  harness: 'claude',
  detail: { kind: 'hooks', file: 'h.json', directory: 'hooks/' },
});
const models = component({
  reference: 'modelSets/heavy',
  kind: 'modelSets',
  name: 'heavy',
  detail: { kind: 'modelSets', models: ['opus', 'sonnet'], default: 'opus' },
});

const catalog = (): FleetComponentCatalog => ({
  format: 'version-2',
  kinds: [
    { kind: 'instructions', label: 'Instructions', description: 'What the agent is told', components: [component()] },
    { kind: 'mcp', label: 'MCP', description: 'Servers', components: [mcp] },
    { kind: 'skills', label: 'Skills', description: 'Skills', components: [skills] },
    { kind: 'settings', label: 'Settings', description: 'Settings', components: [settings] },
    { kind: 'hooks', label: 'Hooks', description: 'Hooks', components: [] },
    { kind: 'modelSets', label: 'Model sets', description: 'Models', components: [models] },
  ],
});

describe('parseReference', () => {
  it('should split <kind>/<name> and refuse anything else', () => {
    should(parseReference('mcp/github')).eql({ kind: 'mcp', name: 'github' });
    should(() => parseReference('mcp')).throw(/<kind>\/<name>/);
    should(() => parseReference('widgets/x')).throw(/<kind>\/<name>/);
  });
});

describe('componentInput', () => {
  it('should build each kind from its flags', () => {
    should(componentInput('instructions', { harness: 'codex' }, undefined)).eql({
      kind: 'instructions',
      harness: 'codex',
    });
    should(componentInput('hooks', { harness: 'claude' }, undefined)).eql({ kind: 'hooks', harness: 'claude' });
    should(componentInput('mcp', { command: 'uvx', arg: ['srv'], url: 'https://x', env: ['K=a=b'] }, undefined)).eql({
      kind: 'mcp',
      command: 'uvx',
      args: ['srv'],
      url: 'https://x',
      env: { K: 'a=b' },
    });
    should(componentInput('mcp', {}, undefined)).eql({ kind: 'mcp' });
    should(componentInput('skills', { item: ['a'] }, undefined)).eql({ kind: 'skills', items: ['a'] });
    should(componentInput('settings', { harness: 'claude', flag: ['--x'] }, undefined)).eql({
      kind: 'settings',
      harness: 'claude',
      flags: ['--x'],
    });
    should(componentInput('modelSets', { model: ['a', 'b'] }, undefined)).eql({
      kind: 'modelSets',
      models: ['a', 'b'],
      default: 'a',
    });
  });

  it('should keep what an edit does not name, and keep a hidden value hidden', () => {
    should(componentInput('mcp', { env: ['MODE=slow'] }, mcp)).eql({
      kind: 'mcp',
      command: 'npx',
      args: ['-y', 'server'],
      url: 'https://mcp.example.com',
      env: { TOKEN: { keep: true }, MODE: 'slow' },
    });
    should(componentInput('settings', {}, settings)).eql({
      kind: 'settings',
      harness: 'claude',
      flags: ['--verbose'],
      env: { A: '1' },
    });
    should(componentInput('skills', {}, skills)).eql({ kind: 'skills', items: ['a', 'b'] });
    should(componentInput('modelSets', { default: 'sonnet' }, models)).eql({
      kind: 'modelSets',
      models: ['opus', 'sonnet'],
      default: 'sonnet',
    });
    should(componentInput('mcp', {}, component({ detail: { kind: 'instructions', file: 'x' } }))).eql({ kind: 'mcp' });
  });

  it('should say what each kind is missing', () => {
    should(() => componentInput('skills', {}, undefined)).throw(/--item/);
    should(() => componentInput('settings', {}, undefined)).throw(/--harness/);
    should(() => componentInput('hooks', {}, undefined)).throw(/--harness/);
    should(() => componentInput('modelSets', {}, undefined)).throw(/--model/);
    should(() => componentInput('mcp', { env: ['NOVALUE'] }, undefined)).throw(/NAME=value/);
    should(() => componentInput('mcp', { arg: [], command: '' }, undefined)).throw(/not complete/);
  });
});

describe('component renderings', () => {
  it('should show what each kind holds, its notes and why it cannot be removed', () => {
    const text = renderComponent(mcp);
    should(text)
      .match(/mcp\/github {2}\(both tools\)/)
      .and.match(/Runs: npx -y server/)
      .and.match(/Address: https:\/\/mcp\.example\.com/);
    should(text)
      .match(/Env: TOKEN=\(hidden\)/)
      .and.match(/Env: MODE=fast/);
    should(text)
      .match(/Partly supported on Codex: no url servers/)
      .and.match(/Note: Command not found: npx/);
    should(text).match(/Cannot remove yet: default uses it\./);
    should(renderComponent(settings))
      .match(/\(Claude Code\)/)
      .and.match(/Flags: --verbose/)
      .and.match(/Env: A=1/);
    should(renderComponent(skills)).match(/Skills: a, b/);
    should(renderComponent(hooks))
      .match(/File: h\.json/)
      .and.match(/Folder: hooks\//);
    should(renderComponent(models))
      .match(/Models: opus, sonnet/)
      .and.match(/Starts with: opus/);
    should(renderComponent(component())).match(/File: components\/instructions\/main\.md/);
    should(renderComponent(component({ detail: { kind: 'mcp', env: [] } }))).not.match(/Runs|Address/);
    should(renderComponent(component({ detail: { kind: 'settings', env: [] } }))).not.match(/File|Flags/);
    should(renderComponent(component({ detail: { kind: 'hooks' } }))).not.match(/File|Folder/);
  });

  it('should list every kind, saying when one has none', () => {
    const text = renderComponentCatalog(catalog().kinds, 'fz');
    should(text).match(/MCP — Servers\n {2}github {2}\(both tools\) {2}used by 1 profile\(s\) {2}· 1 note\(s\)/);
    should(text)
      .match(/Hooks — Hooks\n {2}none yet/)
      .and.match(/fz component show/);
  });
});

describe('registerComponentCommands', () => {
  it('should list all kinds or one, as words or JSON, and refuse an unknown kind', async () => {
    const world = fakeWorld({ gateway: { components: catalog } });
    await runCommand(registerComponentCommands, world, ['components']);
    await runCommand(registerComponentCommands, world, ['components', 'mcp', '--json']);
    should(world.out.lines[0]?.text).match(/Instructions — /);
    should(JSON.parse(world.out.lines[1]?.text as string).kinds.map((group: { kind: string }) => group.kind)).eql([
      'mcp',
    ]);
    await should(runCommand(registerComponentCommands, world, ['components', 'widgets'])).be.rejectedWith(/not a kind/);
  });

  it('should show one component, or refuse one it does not have', async () => {
    const world = fakeWorld({ gateway: { components: catalog } });
    await runCommand(registerComponentCommands, world, ['component', 'show', 'mcp/github']);
    await runCommand(registerComponentCommands, world, ['component', 'show', 'mcp/github', '--json']);
    should(world.out.lines[0]?.text).match(/^mcp\/github/);
    should(JSON.parse(world.out.lines[1]?.text as string).name).equal('github');
    await should(runCommand(registerComponentCommands, world, ['component', 'show', 'mcp/none'])).be.rejectedWith(
      /no component mcp\/none/,
    );
    await should(runCommand(registerComponentCommands, fakeWorld(), ['component', 'show', 'hooks/x'])).be.rejectedWith(
      /no component/,
    );
  });

  it('should add a component with the text of a local file, without asking', async () => {
    const world = fakeWorld({ files: { 'notes.md': '# Be kind\n' } });
    await runCommand(registerComponentCommands, world, ['component', 'add', 'instructions/main', '--file', 'notes.md']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: '# Be kind\n',
      create: true,
    });
    should(world.prompt.questions).be.empty();
    await should(
      runCommand(registerComponentCommands, world, ['component', 'add', 'instructions/x', '--file', 'missing.md']),
    ).be.rejectedWith('Could not read missing.md.');
  });

  it('should edit a component it has after a yes, and refuse one it does not', async () => {
    const world = fakeWorld({ answers: ['y'], gateway: { components: catalog } });
    await runCommand(registerComponentCommands, world, ['component', 'edit', 'skills/mine', '--item', 'c']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'component.put',
      name: 'mine',
      component: { kind: 'skills', items: ['c'] },
      create: false,
    });
    await should(
      runCommand(registerComponentCommands, world, ['component', 'edit', 'skills/none', '--item', 'c']),
    ).be.rejectedWith(/fz component add skills\/none/);
  });

  it('should remove a component, taking it out of profiles when asked', async () => {
    const world = fakeWorld();
    await runCommand(registerComponentCommands, world, [
      'component',
      'rm',
      'mcp/github',
      '--yes',
      '--remove-from-profiles',
    ]);
    await runCommand(registerComponentCommands, world, ['component', 'rm', 'mcp/linear', '--yes']);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'component.remove', componentKind: 'mcp', name: 'github', removeFromProfiles: true },
      { kind: 'component.remove', componentKind: 'mcp', name: 'linear' },
    ]);
  });
});
