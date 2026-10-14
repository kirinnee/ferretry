import { describe, expect, it } from 'bun:test';
import { FleetAccountChangeSchema } from '@ferretry/protocol';
import {
  blankDraft,
  componentBadges,
  componentChange,
  componentDraftModels,
  counted,
  draftDefault,
  draftFromComponent,
  draftProblem,
  listed,
  mcpCommandLine,
  profilesWithLayer,
  reuseLabel,
  settingsEntries,
  settingsValue,
  splitCommandLine,
} from '../../../../../src/features/fleet/components/component-model.ts';
import {
  changeOf,
  claudeSettings,
  component,
  github,
  hooks,
  instructions,
  models,
  notes,
  profileCatalog,
  secretRef,
  skills,
} from './catalog-fixture.ts';

const all = [instructions, github, notes, skills, claudeSettings, hooks, models];

describe('componentBadges', () => {
  it('says a generic component works in both harnesses and a harness one belongs to one', () => {
    expect(componentBadges(instructions, 'studio-mac')).toEqual([{ text: 'Claude Code and Codex', tone: 'pend' }]);
    expect(componentBadges(hooks, 'studio-mac')).toEqual([{ text: 'Claude Code only', tone: 'accent' }]);
  });

  it('adds partial support (E22), warnings (E8), a path to check (E30) and stored secrets (E7)', () => {
    expect(componentBadges(skills, 'm').map(badge => badge.text)).toEqual([
      'Claude Code and Codex',
      'Partly supported on Codex',
    ]);
    expect(componentBadges(notes, 'work-linux')).toEqual([
      { text: 'Claude Code and Codex', tone: 'pend' },
      { text: 'Command not found: uvx', tone: 'warn', warn: true },
      { text: 'Check this path on work-linux', tone: 'warn', warn: true },
    ]);
    expect(componentBadges(github, 'm').at(-1)).toEqual({ text: '1 secret stored', tone: 'pend', lock: true });
    expect(componentBadges(claudeSettings, 'm').at(-1)).toEqual({ text: '1 secret stored', tone: 'pend', lock: true });
  });
});

describe('words', () => {
  it('counts and lists in plain English', () => {
    expect(counted(1, 'profile')).toBe('1 profile');
    expect(counted(2, 'profile')).toBe('2 profiles');
    expect(counted(0, 'body', 'bodies')).toBe('0 bodies');
    expect(listed([])).toBe('');
    expect(listed(['a'])).toBe('a');
    expect(listed(['a', 'b', 'c'])).toBe('a, b and c');
    expect(reuseLabel('modelSets', 'Heavy')).toBe('Model set Heavy');
  });

  it('names the profiles that have a component as their own layer', () => {
    expect(profilesWithLayer('mcp/github', profileCatalog().profiles)).toEqual(['Default']);
  });
});

describe('command lines', () => {
  it('joins and splits an MCP command, quoting only what needs it', () => {
    expect(mcpCommandLine(github.detail as never)).toBe('npx -y @modelcontextprotocol/server-github');
    expect(mcpCommandLine({ kind: 'mcp', command: 'run', args: ['a b', 'say "hi"', ''], env: [] })).toBe(
      'run "a b" "say \\"hi\\"" ""',
    );
    expect(mcpCommandLine({ kind: 'mcp', url: 'https://mcp.example/sse', env: [] })).toBe('https://mcp.example/sse');
    expect(mcpCommandLine({ kind: 'mcp', env: [] })).toBe('');
    expect(splitCommandLine('run "a b" "say \\"hi\\"" ""')).toEqual(['run', 'a b', 'say "hi"', '']);
    expect(splitCommandLine("  uvx 'one two'  a\\ b  ")).toEqual(['uvx', 'one two', 'a b']);
    expect(splitCommandLine('')).toEqual([]);
  });
});

describe('drafts', () => {
  it('starts each kind from what the component holds', () => {
    expect(draftFromComponent(instructions)).toMatchObject({ body: '# How we work\n- Small PRs.', redacted: false });
    expect(draftFromComponent(github)).toMatchObject({
      body: 'npx -y @modelcontextprotocol/server-github',
      keptEnv: ['GITHUB_TOKEN', 'LOG'],
    });
    expect(draftFromComponent(skills).body).toBe('release-notes\npr-review');
    expect(draftFromComponent(claudeSettings)).toMatchObject({
      harness: 'claude',
      body: 'permissions.defaultMode = plan\nstatusLine = on',
      hiddenKeys: ['env.ANTHROPIC_API_KEY'],
      keptEnv: ['API_KEY'],
      flags: ['--verbose'],
    });
    expect(draftFromComponent(models)).toMatchObject({
      body: 'claude-opus-5\nclaude-sonnet-5',
      defaultModel: 'claude-sonnet-5',
    });
    expect(draftFromComponent(hooks).directory).toBe(false);
  });

  it('marks text it cannot save, a hooks folder, and a file it could not read', () => {
    const redacted = component({ ...instructions, content: { form: 'text', text: '‹hidden›', redacted: true } });
    expect(draftFromComponent(redacted).redacted).toBe(true);
    const folder = component({ ...hooks, detail: { kind: 'hooks', directory: 'hooks' }, content: undefined });
    expect(draftFromComponent(folder)).toMatchObject({ directory: true, body: '' });
    const unread = component({ ...claudeSettings, content: undefined, detail: { kind: 'settings', env: [] } });
    expect(draftFromComponent(unread)).toMatchObject({ body: '', hiddenKeys: [], flags: [] });
  });

  it('keeps model ids once and falls back to the first when the default was removed', () => {
    const draft = { ...blankDraft('modelSets'), body: 'a\n\n a \nb', defaultModel: 'gone' };
    expect(componentDraftModels(draft)).toEqual(['a', 'b']);
    expect(draftDefault(draft)).toBe('a');
    expect(draftDefault({ ...draft, defaultModel: 'b' })).toBe('b');
  });

  it('reads settings lines and values', () => {
    expect([...settingsEntries('a = 1\n b.c=x = y \n').entries]).toEqual([
      ['a', '1'],
      ['b.c', 'x = y'],
    ]);
    expect(settingsEntries('a = 1\nnot a line').bad).toBe('not a line');
    expect(settingsEntries('= 2').bad).toBe('= 2');
    expect(settingsValue('true')).toBe(true);
    expect(settingsValue('[1]')).toEqual([1]);
    expect(settingsValue('plan')).toBe('plan');
  });
});

describe('draftProblem', () => {
  const named = (kind: Parameters<typeof blankDraft>[0], body: string, name = 'New one') => ({
    ...blankDraft(kind),
    name,
    body,
  });

  it('asks for a usable, free name', () => {
    expect(draftProblem(blankDraft('instructions'), all)).toBe('Give it a name.');
    expect(draftProblem(named('instructions', 'x', 'a/b'), all)).toBe('Use a name without a slash or "..".');
    expect(draftProblem(named('mcp', 'npx', 'github'), all)).toBe('You already have one called github.');
    expect(draftProblem(named('mcp', 'npx', 'github'), all, 'github')).toBeUndefined();
    expect(draftProblem(named('instructions', 'x', 'github'), all)).toBeUndefined();
  });

  it('refuses text with a hidden secret, a hooks folder, and an empty field per kind', () => {
    expect(draftProblem({ ...named('instructions', 'x'), redacted: true }, all)).toContain('looks like a secret');
    expect(draftProblem({ ...named('hooks', ''), directory: true }, all)).toContain('folder');
    expect(draftProblem(named('mcp', '  '), all)).toBe('Type the command that starts the server.');
    expect(draftProblem(named('mcp', 'npx x'), all)).toBeUndefined();
    expect(draftProblem(named('skills', ''), all)).toBe('Name at least one skill.');
    expect(draftProblem(named('skills', 'a'), all)).toBeUndefined();
    expect(draftProblem(named('settings', 'a = 1\nbroken'), all)).toBe('Write each setting as key = value: “broken”.');
    expect(draftProblem(named('settings', 'a = 1'), all)).toBeUndefined();
    expect(draftProblem(named('modelSets', ''), all)).toBe('Add at least one model.');
    expect(draftProblem(named('modelSets', 'm'), all)).toBeUndefined();
    expect(draftProblem(named('hooks', '{}'), all)).toBeUndefined();
  });
});

describe('componentChange', () => {
  const valid = (change: unknown) => FleetAccountChangeSchema.parse(change);

  it('sends instructions and hooks as their text', () => {
    expect(valid(componentChange({ ...blankDraft('instructions'), name: ' Docs ', body: 'Read me' }, true))).toEqual({
      kind: 'component.put',
      name: 'Docs',
      component: { kind: 'instructions' },
      content: 'Read me',
      create: true,
    });
    expect(changeOf(valid(componentChange(draftFromComponent(hooks), false)), 'component.put')).toMatchObject({
      component: { kind: 'hooks', harness: 'claude' },
      content: '{"PostToolUse": []}',
      create: false,
    });
    expect(
      changeOf(
        componentChange({ ...blankDraft('hooks'), name: 'h', harness: undefined, body: '{}' }, true),
        'component.put',
      ).component,
    ).toEqual({ kind: 'hooks', harness: 'claude' });
    expect(
      changeOf(componentChange({ ...draftFromComponent(instructions), harness: 'codex' }, false), 'component.put')
        .component,
    ).toEqual({ kind: 'instructions', harness: 'codex' });
  });

  it('sends an MCP command line as command and args, or a URL, keeping its environment', () => {
    expect(changeOf(valid(componentChange(draftFromComponent(github), false)), 'component.put').component).toEqual({
      kind: 'mcp',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: { keep: true }, LOG: { keep: true } },
    });
    expect(
      changeOf(
        componentChange({ ...blankDraft('mcp'), name: 'web', body: ' https://mcp.example/sse ' }, true),
        'component.put',
      ).component,
    ).toEqual({ kind: 'mcp', url: 'https://mcp.example/sse' });
    expect(
      changeOf(componentChange({ ...blankDraft('mcp'), name: 'one', body: 'serve' }, true), 'component.put').component,
    ).toEqual({ kind: 'mcp', command: 'serve' });
  });

  it('sends skills once each', () => {
    expect(
      changeOf(componentChange({ ...blankDraft('skills'), name: 's', body: 'a\nb\na' }, true), 'component.put')
        .component,
    ).toEqual({ kind: 'skills', items: ['a', 'b'] });
  });

  it('sends settings by entry, keeping every hidden value and the environment and flags', () => {
    const draft = { ...draftFromComponent(claudeSettings), body: 'permissions.defaultMode = default\ncount = 3' };
    expect(changeOf(valid(componentChange(draft, false)), 'component.put').component).toEqual({
      kind: 'settings',
      harness: 'claude',
      entries: {
        'permissions.defaultMode': { value: 'default' },
        count: { value: 3 },
        'env.ANTHROPIC_API_KEY': { keep: true },
      },
      flags: ['--verbose'],
      env: { API_KEY: { keep: true } },
    });
    // A hidden key the person typed a new value for is sent as that value, not kept.
    expect(
      changeOf(
        componentChange({ ...draft, body: `env.ANTHROPIC_API_KEY = ${secretRef('KEY')}` }, false),
        'component.put',
      ).component,
    ).toMatchObject({ entries: { 'env.ANTHROPIC_API_KEY': { value: secretRef('KEY') } } });
    expect(
      changeOf(
        componentChange({ ...blankDraft('settings'), name: 'n', harness: undefined, body: '' }, true),
        'component.put',
      ).component,
    ).toEqual({ kind: 'settings', harness: 'claude', entries: {} });
  });

  it('sends a model set with its default', () => {
    expect(
      changeOf(
        componentChange({ ...blankDraft('modelSets'), name: 'Heavy', body: 'a\nb', defaultModel: 'b' }, true),
        'component.put',
      ).component,
    ).toEqual({ kind: 'modelSets', models: ['a', 'b'], default: 'b' });
  });
});

describe('componentBadges · where a copy came from', () => {
  it('names a cloned component’s source by the reader’s label, else by the name it gave itself', () => {
    const copied = { ...instructions, clonedFrom: 'work-mac', clonedFromDaemon: 'sha256:work' };
    expect(componentBadges(copied, 'studio-mac', new Map([['sha256:work', 'Work laptop']]))).toContainEqual({
      text: 'Copied from Work laptop',
      tone: 'pend',
    });
    expect(componentBadges(copied, 'studio-mac')).toContainEqual({
      text: 'Copied from work-mac (the name it gave itself)',
      tone: 'pend',
    });
  });
});
