import { describe, expect, it } from 'bun:test';
import type { FleetComponentCatalog, SessionFsEntry } from '@ferretry/protocol';
import {
  contextEmptyCopy,
  contextMcpServers,
  docChips,
  docSize,
  FERRETRY_TOOLS_SERVER,
  FOLDER_TABS,
  instructionDocs,
  matchesQuery,
  mcpChips,
  MCP_SCOPE_LABEL,
  mcpRowStatus,
  mcpScopeTitle,
  scopedMcpServers,
  signalAuthor,
  signalChips,
  signalMeta,
  signalOutcome,
  signalRows,
  skillChips,
  visibleDocs,
  visibleMcpServers,
  visibleSignals,
  visibleSkills,
} from '../../../../src/features/context-rail/context-rail-model.ts';
import { component } from '../fleet/components/catalog-fixture.ts';
import { answeredItem, DOCS, MCP, NOW, openItem, SKILLS, skill, snapshot } from './context-rail-fixtures.ts';

describe('matchesQuery', () => {
  it('matches every row on a blank search and otherwise any field, ignoring case', () => {
    expect(matchesQuery('  ', 'anything')).toBe(true);
    expect(matchesQuery('LIN', 'github', 'linear')).toBe(true);
    expect(matchesQuery('notion', 'github', null, undefined)).toBe(false);
  });
});

describe('signals', () => {
  const board = snapshot(
    [openItem({ id: 'A3', waitingSince: '2026-10-16T09:59:00.000Z' }), openItem()],
    [answeredItem(), answeredItem({ id: 'A4', resolvedAt: '2026-10-16T09:30:00.000Z', subject: 'Later' })],
  );

  it('lists open items oldest first, then answered ones newest first', () => {
    expect(signalRows(board).map(row => `${row.state}:${row.item.id}`)).toEqual([
      'open:A1',
      'open:A3',
      'answered:A4',
      'answered:A2',
    ]);
  });

  it('counts each chip under the search, and shows only the chosen one', () => {
    const rows = signalRows(board);
    expect(signalChips(rows, '')).toEqual([
      { key: 'open', label: 'Open', count: 2 },
      { key: 'answered', label: 'Answered', count: 2 },
    ]);
    expect(signalChips(rows, 'start over').map(chip => chip.count)).toEqual([0, 2]);
    expect(visibleSignals(rows, 'later', 'answered').map(row => row.item.id)).toEqual(['A4']);
    expect(visibleSignals(rows, 'later', 'open')).toEqual([]);
  });

  it('names who raised it, how long ago, and what kind of ask it is', () => {
    const [open, answered] = signalRows(snapshot());
    expect(signalMeta(open!, 'Agent', NOW)).toBe('Hadi · 2m ago · pick one');
    expect(signalMeta(answered!, 'Agent', NOW)).toBe('Agent · 1h ago · answered');
    expect(signalAuthor(openItem({ raisedBy: 'daemon', raisedBySession: null, raisedByName: null }), 'Agent')).toBe(
      'Ferretry',
    );
    expect(signalAuthor(openItem({ raisedBy: 'human', raisedBySession: null, raisedByName: null }), 'Agent')).toBe(
      'You',
    );
  });

  it('says how an answered item ended', () => {
    expect(signalOutcome(answeredItem())).toBe('Chose “Start over”');
    expect(signalOutcome(answeredItem({ response: undefined, disposition: 'dismissed' }))).toBe('Dismissed');
    expect(signalOutcome(answeredItem({ response: undefined }))).toBe('Done');
  });
});

describe('MCP', () => {
  it('says where each server stands and offers Sign in only where it is needed', () => {
    expect(mcpRowStatus(MCP[0]!, NOW)).toEqual({
      label: 'Runs locally',
      tone: 'none',
      canSignIn: false,
      signInLabel: 'Sign in',
    });
    expect(mcpRowStatus({ name: 'docs', transport: 'url', signsIn: false }, NOW).label).toBe('No sign-in needed');
    expect(mcpRowStatus(MCP[1]!, NOW)).toMatchObject({ tone: 'ok', canSignIn: false });
    expect(mcpRowStatus(MCP[2]!, NOW)).toEqual({
      label: 'Needs sign-in',
      tone: 'warn',
      canSignIn: true,
      signInLabel: 'Sign in',
    });
    const lapsed = {
      ...MCP[1]!,
      connection: { ...MCP[1]!.connection!, state: 'expired' as const, renewable: false },
    };
    expect(mcpRowStatus(lapsed, NOW)).toMatchObject({ canSignIn: true, signInLabel: 'Sign in again' });
  });

  it('counts and filters by Needs sign-in under the search', () => {
    expect(mcpChips(MCP, '', NOW)).toEqual([
      { key: 'all', label: 'All', count: 3 },
      { key: 'needs-sign-in', label: 'Needs sign-in', count: 1 },
    ]);
    expect(mcpChips(MCP, 'git', NOW).map(chip => chip.count)).toEqual([1, 0]);
    expect(visibleMcpServers(MCP, '', 'needs-sign-in', NOW).map(server => server.name)).toEqual(['notion']);
    expect(visibleMcpServers(MCP, 'LIN', 'all', NOW).map(server => server.name)).toEqual(['linear']);
  });

  it('joins the MCP components with their sign-ins, narrowed to one runtime when asked', () => {
    const catalog = {
      format: 'version-2',
      kinds: [
        {
          kind: 'mcp',
          label: 'MCP servers',
          description: 'Tools.',
          components: [
            component({
              reference: 'mcp/notion',
              kind: 'mcp',
              name: 'notion',
              detail: { kind: 'mcp', url: 'https://mcp.notion.example', auth: 'oauth', env: [] },
              usedBy: { profiles: ['Default'], runtimes: ['claude-default'] },
            }),
            component({
              reference: 'mcp/docs',
              kind: 'mcp',
              name: 'Docs',
              detail: { kind: 'mcp', url: 'https://docs.example/mcp', env: [] },
            }),
            component({
              reference: 'mcp/github',
              kind: 'mcp',
              name: 'github',
              detail: { kind: 'mcp', command: 'npx', env: [] },
              usedBy: { profiles: ['Default'], runtimes: ['claude-default'] },
            }),
          ],
        },
        {
          kind: 'skills',
          label: 'Skills',
          description: 'Skills.',
          components: [
            component({
              reference: 'skills/mine',
              kind: 'skills',
              name: 'mine',
              detail: { kind: 'skills', items: ['a'] },
            }),
          ],
        },
      ],
    } as unknown as FleetComponentCatalog;
    const connection = MCP[1]!.connection!;
    const notion = { ...connection, component: 'notion' };

    expect(contextMcpServers(catalog, [notion])).toEqual([
      { name: 'Docs', transport: 'url', signsIn: false, scope: 'login' },
      { name: 'github', transport: 'command', signsIn: false, scope: 'login' },
      { name: 'notion', transport: 'url', signsIn: true, scope: 'login', connection: notion },
    ]);
    expect(contextMcpServers(catalog, [], 'claude-default').map(server => server.name)).toEqual(['github', 'notion']);
  });

  it('scopes every server a ferret sees: Ferretry’s own tools first, then the project’s, then the login’s', () => {
    expect(scopedMcpServers(MCP, null)).toEqual([
      { name: FERRETRY_TOOLS_SERVER, transport: 'command', signsIn: false, scope: 'ferretry' },
      { name: 'github', transport: 'command', signsIn: false, scope: 'login' },
      {
        name: 'linear',
        transport: 'url',
        signsIn: true,
        scope: 'login',
        connection: MCP[1]!.connection,
      },
      { name: 'notion', transport: 'url', signsIn: true, scope: 'login' },
    ]);
    expect(scopedMcpServers([], [{ name: 'repo-tools', transport: 'command' }])).toEqual([
      { name: FERRETRY_TOOLS_SERVER, transport: 'command', signsIn: false, scope: 'ferretry' },
      { name: 'repo-tools', transport: 'command', signsIn: false, scope: 'project' },
    ]);
  });

  it('labels and titles every MCP scope', () => {
    expect(MCP_SCOPE_LABEL).toEqual({ project: 'Project', login: 'Login', ferretry: 'Ferretry' });
    expect(mcpScopeTitle('project')).toBe('The repo’s .mcp.json, shared with everyone on the repo');
    expect(mcpScopeTitle('login')).toBe('The login’s profile: every ferret on it');
    expect(mcpScopeTitle('ferretry')).toBe('Ferretry’s built-in tools server');
  });
});

describe('FOLDER_TABS', () => {
  it('opens on Files, then Docs, Skills, MCP — the folder itself before what the agent reaches from it', () => {
    expect(FOLDER_TABS).toEqual(['files', 'docs', 'skills', 'mcp']);
  });
});

describe('skills', () => {
  it('offers Codex only when the catalog has a Codex skill', () => {
    expect(skillChips(SKILLS.skills, '')).toEqual([
      { key: 'all', label: 'All', count: 3 },
      { key: 'claude', label: 'Claude', count: 2 },
      { key: 'generic', label: 'Generic', count: 1 },
    ]);
    const mixed = [
      ...SKILLS.skills,
      skill({ name: 'codex-only', origin: 'codex' }),
      skill({ name: 'odd', origin: 'unknown' }),
    ];
    expect(skillChips(mixed, '').map(chip => `${chip.key}:${chip.count}`)).toEqual([
      'all:5',
      'claude:2',
      'codex:1',
      'generic:2',
    ]);
  });

  it('searches name and description within the chosen chip', () => {
    expect(visibleSkills(SKILLS.skills, 'green', 'all').map(entry => entry.name)).toEqual(['babysit-pr']);
    expect(visibleSkills(SKILLS.skills, '', 'generic').map(entry => entry.name)).toEqual(['floop']);
    expect(visibleSkills(SKILLS.skills, 'loop', 'claude')).toEqual([]);
  });
});

describe('docs', () => {
  const entry = (name: string, extra: Partial<SessionFsEntry> = {}): SessionFsEntry => ({
    name,
    type: 'file',
    ...extra,
  });

  it('keeps the instruction files a folder listing holds, in a fixed order', () => {
    const listing = [
      entry('README.md'),
      entry('AGENTS.md', { size: 10 }),
      entry('CLAUDE.md', { size: 2048 }),
      entry('GEMINI.md', { denied: true }),
      entry('CLAUDE.local.md', { escapes: true }),
      entry('AGENTS.override.md', { type: 'dir' }),
    ];
    expect(instructionDocs(listing)).toEqual([
      { path: 'CLAUDE.md', name: 'CLAUDE.md', size: 2048 },
      { path: 'AGENTS.md', name: 'AGENTS.md', size: 10 },
    ]);
    expect(instructionDocs([entry('AGENTS.md')], 'packages/pwa')).toEqual([
      { path: 'packages/pwa/AGENTS.md', name: 'AGENTS.md' },
    ]);
  });

  it('counts Claude and generic files and searches their paths', () => {
    expect(docChips(DOCS, '').map(chip => `${chip.key}:${chip.count}`)).toEqual(['all:2', 'claude:1', 'generic:1']);
    expect(visibleDocs(DOCS, '', 'generic').map(doc => doc.name)).toEqual(['AGENTS.md']);
    expect(visibleDocs(DOCS, 'claude', 'all').map(doc => doc.name)).toEqual(['CLAUDE.md']);
    expect(docSize(DOCS[0]!)).toBe('13 KB');
    expect(docSize({ path: 'x', name: 'x' })).toBe('');
  });
});

describe('contextEmptyCopy', () => {
  it('tells an empty list from a filtered-out one', () => {
    expect(contextEmptyCopy('signals', 0, '', 'Open')).toBe('Nothing is waiting on you here.');
    expect(contextEmptyCopy('files', 0, '', 'All')).toBe('This folder is empty.');
    expect(contextEmptyCopy('mcp', 0, 'x', 'All')).toBe('This agent has no MCP servers.');
    expect(contextEmptyCopy('skills', 0, '', 'All')).toBe('No skills are installed for this agent.');
    expect(contextEmptyCopy('docs', 0, '', 'All')).toBe('No instruction files in this folder.');
    expect(contextEmptyCopy('docs', 2, ' agents ', 'Claude')).toBe('Nothing under Claude matches “agents”.');
    expect(contextEmptyCopy('signals', 1, '', 'Answered')).toBe('Nothing under Answered.');
  });
});
