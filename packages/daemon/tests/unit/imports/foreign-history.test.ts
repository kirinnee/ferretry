import { describe, expect, test } from 'bun:test';
import {
  type ForeignHistoryEntry,
  type ForeignHistoryFiles,
  ForeignHistoryImporter,
} from '../../../src/lib/imports/foreign-history.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';

class FixtureFiles implements ForeignHistoryFiles {
  constructor(
    private readonly tree: Readonly<Record<string, readonly ForeignHistoryEntry[]>>,
    private readonly texts: Readonly<Record<string, string>>,
  ) {}

  async entries(directory: string): Promise<readonly ForeignHistoryEntry[]> {
    return this.tree[directory] ?? [];
  }

  async text(file: string): Promise<string | undefined> {
    return this.texts[file];
  }
}

const CLAUDE_ROOT = '/fixture/claude/projects';
const CODEX_ROOT = '/fixture/codex/sessions';
const validClaude = JSON.stringify({
  type: 'user',
  timestamp: '2026-08-01T12:00:00.000Z',
  sessionId: 'foreign-claude',
  message: { role: 'user', content: 'Read-only history must stay honest.' },
});

function importer(files: ForeignHistoryFiles) {
  return new ForeignHistoryImporter(
    files,
    { claudeProjects: CLAUDE_ROOT, codexSessions: CODEX_ROOT },
    { claude: new ClaudeTranscriptParser(), codex: new CodexTranscriptParser() },
  );
}

describe('ForeignHistoryImporter', () => {
  test('indexes valid Claude fixtures in place and labels them read-only', async () => {
    const source = `${CLAUDE_ROOT}/project/foreign-claude.jsonl`;
    const history = importer(
      new FixtureFiles(
        {
          [CLAUDE_ROOT]: [{ name: 'project', kind: 'directory' }],
          [`${CLAUDE_ROOT}/project`]: [{ name: 'foreign-claude.jsonl', kind: 'file' }],
        },
        { [source]: `${validClaude}\n` },
      ),
    );

    const listing = await history.list();

    expect(listing.skipped).toEqual([]);
    expect(listing.conversations).toHaveLength(1);
    expect(listing.conversations[0]).toMatchObject({
      harness: 'claude',
      title: 'Read-only history must stay honest.',
      source,
      eventCount: 1,
      readOnly: true,
    });
    const first = listing.conversations[0];
    if (first === undefined) throw new Error('expected a discovered fixture conversation');
    const imported = await history.get(first.id);
    expect(imported?.events).toHaveLength(1);
  });

  test('reports malformed history as skipped rather than an empty conversation', async () => {
    const source = `${CLAUDE_ROOT}/project/damaged.jsonl`;
    const history = importer(
      new FixtureFiles(
        {
          [CLAUDE_ROOT]: [{ name: 'project', kind: 'directory' }],
          [`${CLAUDE_ROOT}/project`]: [{ name: 'damaged.jsonl', kind: 'file' }],
        },
        { [source]: '{not json}\n' },
      ),
    );

    await expect(history.list()).resolves.toEqual({
      conversations: [],
      skipped: [{ harness: 'claude', source, reason: 'invalid-json' }],
    });
  });

  test('never follows symlinks while walking foreign homes', async () => {
    const history = importer(
      new FixtureFiles(
        {
          [CLAUDE_ROOT]: [{ name: 'outside', kind: 'other' }],
        },
        {},
      ),
    );

    await expect(history.list()).resolves.toEqual({ conversations: [], skipped: [] });
  });
});
