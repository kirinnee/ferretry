import { describe, expect, it } from 'bun:test';
import {
  counts,
  importChange,
  itemIds,
  nameProblem,
  resultSentences,
  skipList,
  stepsSettledBy,
  toolModel,
  versionOf,
} from '../../../../../app/features/import-wizard/model.ts';
import { toolHeadline } from '../../../../../app/features/import-wizard/mapping-words.ts';
import { ImportItemIdSchema } from '../../../../../contract/index.ts';
import { CLAUDE_FULL, CODEX_FULL, scanOf } from './scans.ts';

describe('the wizard model, per scan', () => {
  it('a fresh machine with nothing installed: both tools read as not installed, with the command to run', () => {
    const scan = scanOf({ claude: 'absent', codex: 'absent' });
    const claude = toolModel('claude-code', scan, null);
    const codex = toolModel('codex', scan, null);
    expect(claude.stage).toBe('not-installed');
    expect(claude.install).toEqual({ kind: 'runnable', command: 'brew install --cask claude-code' });
    expect(codex.install).toEqual({ kind: 'runnable', command: 'npm i -g @openai/codex' });
    expect(claude.empty).toBe(true);
    expect(claude.suggestedName).toBe('claude-code-default');
  });

  it('installed but not signed in', () => {
    const scan = scanOf({ claude: { account: { state: 'not-signed-in' } } });
    const model = toolModel('claude-code', scan, '2.1.0');
    expect(model.stage).toBe('needs-sign-in');
    expect(model.version).toBe('2.1.0');
    expect(model.email).toBeNull();
  });

  it('everything found: each group lists what it becomes', () => {
    const model = toolModel('claude-code', scanOf({ claude: CLAUDE_FULL }), '2.1.0');
    expect(model.stage).toBe('ready');
    expect(model.email).toBe('sam@example.test');
    expect(model.groups.map(group => group.key)).toEqual(['instructions', 'mcp', 'skill', 'settings', 'env']);
    const becomes = Object.fromEntries(model.groups.map(group => [group.key, group.items[0]?.becomes]));
    expect(becomes).toEqual({
      instructions: 'Instructions in your Default profile',
      mcp: 'MCP server',
      skill: 'Skill',
      settings: 'Claude settings',
      env: 'This login’s environment',
    });
    expect(itemIds(model)).toEqual([
      'claude-code:instructions',
      'claude-code:mcp:notes',
      'claude-code:mcp:issues',
      'claude-code:skill:review',
      'claude-code:skill:release-notes',
      'claude-code:settings',
      'claude-code:env',
    ]);
    // Every id is one the daemon's grammar takes.
    for (const id of itemIds(model)) expect(ImportItemIdSchema.safeParse(id).success).toBe(true);
  });

  it('secret-looking keys are listed by name, without the env. prefix, and carry no value', () => {
    const model = toolModel('claude-code', scanOf({ claude: CLAUDE_FULL }), null);
    expect(model.groups.find(group => group.key === 'env')?.locked).toEqual(['ANTHROPIC_API_KEY', 'NOTES_TOKEN']);
  });

  it('hooks and project instructions are counted, never offered', () => {
    const model = toolModel('claude-code', scanOf({ claude: CLAUDE_FULL }), null);
    expect(model.leftAlone).toEqual({ hooks: 3, projectFolders: 2 });
    expect(itemIds(model).some(id => id.includes('hook'))).toBe(false);
  });

  it('Codex profiles are items; Claude has none', () => {
    const model = toolModel('codex', scanOf({ codex: CODEX_FULL }), null);
    expect(model.groups.find(group => group.key === 'profile')?.items.map(item => item.id)).toEqual([
      'codex:profile:fast',
      'codex:profile:deep',
    ]);
    expect(model.groups.find(group => group.key === 'settings')?.items[0]?.becomes).toBe('Codex settings');
  });

  it('a host name that cannot be an item id is shown but is not left-out-able', () => {
    const model = toolModel('claude-code', scanOf({ claude: { mcpServers: ['a:b'] } }), null);
    expect(model.groups[0]?.items[0]?.id).toBeNull();
    expect(itemIds(model)).toEqual([]);
  });

  it('a duplicate runtime is named', () => {
    const model = toolModel(
      'claude-code',
      scanOf({
        claude: {},
        duplicates: [{ harness: 'claude-code', existing: 'work', suggested: 'claude-code-default' }],
      }),
      null,
    );
    expect(model.duplicateOf).toBe('work');
  });
});

describe('what the person leaves out', () => {
  const model = toolModel('claude-code', scanOf({ claude: CLAUDE_FULL }), null);

  it('nothing unticked: no skip is sent', () => {
    expect(importChange(model, new Set(), ' claude-code-default ')).toEqual({
      kind: 'setup.import',
      include: ['claude-code'],
      names: { 'claude-code': 'claude-code-default' },
    });
  });

  it('unticked boxes become the skip list, in screen order; ids this tool does not offer are dropped', () => {
    const left = new Set([
      'claude-code:mcp:issues',
      'claude-code:env',
      'codex:skill:review',
      'claude-code:skill:review',
    ] as const);
    expect(skipList(model, left)).toEqual(['claude-code:mcp:issues', 'claude-code:skill:review', 'claude-code:env']);
    const change = importChange(model, left, 'mine');
    expect(change).toMatchObject({ skip: ['claude-code:mcp:issues', 'claude-code:skill:review', 'claude-code:env'] });
    expect(counts(model, left)).toEqual({ taken: 4, left: 3 });
  });

  it('never carries a hook, a project folder or a value', () => {
    const sent = JSON.stringify(importChange(model, new Set(), 'x'));
    expect(sent).not.toContain('hook');
    expect(sent).not.toContain('/home/sam');
    expect(sent).not.toContain('ANTHROPIC_API_KEY');
  });

  it('names a bad runtime name', () => {
    expect(nameProblem('  ')).toBe('Give the runtime a name.');
    expect(nameProblem('a'.repeat(201))).toBe('That name is too long.');
    expect(nameProblem('ok')).toBeNull();
  });
});

describe('small readings', () => {
  it('the installed version comes from the update read, or is null', () => {
    expect(versionOf({ installed: { state: 'ok', version: '2.1.0' }, other: 1 })).toBe('2.1.0');
    expect(versionOf({ installed: { state: 'unreadable', reason: 'x' } })).toBeNull();
    expect(versionOf({ installed: null })).toBeNull();
    expect(versionOf('nonsense')).toBeNull();
  });

  it('the header sentence', () => {
    expect(toolHeadline({ installed: false, version: null, signedInAs: 'unknown' })).toBe(
      'Not installed on this machine',
    );
    expect(toolHeadline({ installed: true, version: '2.1.0', signedInAs: { email: 'sam@example.test' } })).toBe(
      'Installed · version 2.1.0 · signed in as sam@example.test',
    );
    expect(toolHeadline({ installed: true, version: null, signedInAs: 'none' })).toBe('Installed · not signed in');
  });

  it('the daemon’s summary splits into sentences; a tool settles the old steps', () => {
    expect(
      resultSentences(
        'Imported 2 parts. Written by the parts that own them: mcp/notes.yaml. Not written: skills/a.yaml (no).',
      ),
    ).toHaveLength(3);
    expect(stepsSettledBy('codex').map(step => `${step.plugin}.${step.stepId}`)).toEqual([
      'codex.harness',
      'logins.login',
      'runtimes.runtimes',
    ]);
  });
});

describe('GitHub-token variables', () => {
  const scan = scanOf({
    claude: { secretKeys: ['env.ANTHROPIC_API_KEY', 'env.GITHUB_TOKEN', 'env.GH_ENTERPRISE_TOKEN'] },
  });
  const model = toolModel('claude-code', scan, null);

  it('are their own choices, apart from the other locked keys', () => {
    const env = model.groups.find(group => group.key === 'env');
    expect(env?.locked).toEqual(['ANTHROPIC_API_KEY']);
    expect(env?.githubTokens).toEqual(['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']);
  });

  it('are never sent until ticked, and then only by name', () => {
    expect(importChange(model, new Set(), 'x')).not.toHaveProperty('tickedEnv');
    expect(importChange(model, new Set(), 'x', new Set(['GITHUB_TOKEN']))).toMatchObject({
      tickedEnv: ['GITHUB_TOKEN'],
    });
  });

  it('a name the scan did not list, or an environment left out, sends nothing', () => {
    expect(importChange(model, new Set(), 'x', new Set(['GH_TOKEN', 'ANTHROPIC_API_KEY']))).not.toHaveProperty(
      'tickedEnv',
    );
    expect(importChange(model, new Set(['claude-code:env']), 'x', new Set(['GITHUB_TOKEN']))).not.toHaveProperty(
      'tickedEnv',
    );
  });
});

describe('an environment that is only GitHub tokens', () => {
  it('has no whole-environment box; each token is still its own choice', () => {
    const model = toolModel('claude-code', scanOf({ claude: { secretKeys: ['env.GH_TOKEN'] } }), null);
    expect(itemIds(model)).toEqual([]);
    expect(model.groups[0]?.githubTokens).toEqual(['GH_TOKEN']);
    expect(importChange(model, new Set(), 'x', new Set(['GH_TOKEN']))).toMatchObject({ tickedEnv: ['GH_TOKEN'] });
  });
});
