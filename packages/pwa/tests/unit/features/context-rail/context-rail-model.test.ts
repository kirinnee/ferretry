import { describe, expect, it } from 'bun:test';
import type { SessionFsEntry } from '@ferretry/protocol';
import { splitFrontMatter } from '../../../../src/features/context-rail/context-rail-lists.tsx';
import {
  CONTEXT_RAIL_TAB_LABEL,
  contextEmptyCopy,
  docChips,
  docSize,
  FOLDER_TABS,
  instructionDocs,
  loadedSkillCount,
  matchesQuery,
  mcpChips,
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

  it('leaves a parked item (snoozed, or replied to) out of the open rows', () => {
    const parked = snapshot(
      [
        openItem({
          id: 'A5',
          parked: { reason: 'snoozed', at: '2026-10-16T10:00:00.000Z', until: '2026-10-17T09:00:00.000Z' },
        }),
        openItem({ id: 'A6', parked: { reason: 'replied', at: '2026-10-16T10:00:00.000Z' } }),
        openItem(),
      ],
      [],
    );
    expect(signalRows(parked).map(row => `${row.state}:${row.item.id}`)).toEqual(['open:A1']);
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
    expect(signalOutcome(answeredItem({ response: undefined, disposition: 'replied' }))).toBe('Replied');
  });
});

describe('MCP', () => {
  it('counts and filters by Needs attention under the search, moved by a Check’s answer', () => {
    const none = new Map();
    expect(mcpChips(MCP.servers, '', none, NOW)).toEqual([
      { key: 'all', label: 'All', count: 6 },
      { key: 'attention', label: 'Needs attention', count: 1 },
    ]);
    expect(visibleMcpServers(MCP.servers, '', 'attention', none, NOW).map(server => server.name)).toEqual(['lint']);
    // The search reads the name, the scope's word and where it points.
    expect(visibleMcpServers(MCP.servers, 'project', 'all', none, NOW).map(server => server.name)).toEqual([
      'notion',
      'lint',
    ]);
    expect(visibleMcpServers(MCP.servers, 'linear.example', 'all', none, NOW).map(server => server.name)).toEqual([
      'linear',
    ]);

    const failed = new Map([
      [
        'id-github-user',
        {
          kind: 'done' as const,
          result: {
            id: 'id-github-user',
            name: 'github',
            transport: 'stdio' as const,
            outcome: 'error' as const,
            elapsedMs: 1,
            checkedAt: '2026-10-16T10:00:00.000Z',
          },
        },
      ],
    ]);
    expect(visibleMcpServers(MCP.servers, '', 'attention', failed, NOW).map(server => server.name)).toEqual([
      'github',
      'lint',
    ]);
  });
});

describe('FOLDER_TABS', () => {
  it('opens on Files, then Instructions, Skills, MCP — the folder itself before what the agent reaches from it', () => {
    expect(FOLDER_TABS).toEqual(['files', 'docs', 'skills', 'mcp']);
    expect(FOLDER_TABS.map(tab => CONTEXT_RAIL_TAB_LABEL[tab])).toEqual(['Files', 'Instructions', 'Skills', 'MCP']);
  });
});

describe('skills', () => {
  it('offers a scope chip only when this ferret has a skill from it', () => {
    expect(skillChips(SKILLS.skills, '')).toEqual([
      { key: 'all', label: 'All', count: 4 },
      { key: 'project', label: 'Project', count: 1 },
      { key: 'user', label: 'User', count: 2 },
      { key: 'ferretry', label: 'Ferretry', count: 1 },
    ]);
    expect(skillChips([skill({ name: 'deploy' })], '').map(chip => chip.key)).toEqual(['all', 'user']);
  });

  it('searches name, description and scope within the chosen chip, and counts what the ferret loads', () => {
    expect(visibleSkills(SKILLS.skills, 'green', 'all').map(entry => entry.name)).toEqual(['babysit-pr']);
    expect(visibleSkills(SKILLS.skills, 'ferretry', 'all').map(entry => entry.name)).toEqual(['babysit-pr']);
    expect(visibleSkills(SKILLS.skills, '', 'user').map(entry => entry.name)).toEqual(['floop', 'summary']);
    expect(loadedSkillCount(SKILLS.skills)).toBe(3);
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

describe('splitFrontMatter', () => {
  it('separates a SKILL.md’s front matter from its body, and leaves a file without one whole', () => {
    expect(splitFrontMatter('---\nname: a\n---\n# A\n')).toEqual({ frontMatter: 'name: a', body: '# A\n' });
    expect(splitFrontMatter('---\r\nname: a\r\n---')).toEqual({ frontMatter: 'name: a', body: '' });
    expect(splitFrontMatter('# No front matter')).toEqual({ frontMatter: null, body: '# No front matter' });
  });
});
