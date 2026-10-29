import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  FileForeignTranscriptReader,
  type ForeignHistoryEntry,
  type ForeignHistoryFiles,
  ForeignHistoryImporter,
} from '../../../src/lib/imports/foreign-history.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import { PacedTranscriptParser, type TranscriptParsePacing } from '../../../src/lib/transcript/sliced.ts';

/** A clock that never advances, so a parse never yields and every test stays one deterministic step. */
const UNPACED: TranscriptParsePacing = { now: () => 0, yieldToLoop: async () => undefined };

class FixtureFiles implements ForeignHistoryFiles {
  constructor(
    private readonly tree: Readonly<Record<string, readonly ForeignHistoryEntry[]>>,
    private readonly texts: Readonly<Record<string, string>>,
    private readonly sizes: Readonly<Record<string, number>> = {},
  ) {}

  async size(file: string): Promise<number | undefined> {
    return this.sizes[file] ?? this.texts[file]?.length;
  }

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
const validCodex = JSON.stringify({
  timestamp: '2026-08-01T12:01:00.000Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Codex history is read-only too.' }],
  },
});

function importer(files: ForeignHistoryFiles) {
  return new ForeignHistoryImporter(
    files,
    { claudeProjects: CLAUDE_ROOT, codexSessions: CODEX_ROOT },
    new FileForeignTranscriptReader(files, {
      claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), UNPACED),
      codex: new PacedTranscriptParser(new CodexTranscriptParser(), UNPACED),
    }),
  );
}

describe('ForeignHistoryImporter', () => {
  test('indexes valid Claude fixtures in place and labels them read-only', async () => {
    const source = `${CLAUDE_ROOT}/project/foreign-claude.jsonl`;
    const codexSource = `${CODEX_ROOT}/2026/08/foreign-codex.jsonl`;
    const history = importer(
      new FixtureFiles(
        {
          [CLAUDE_ROOT]: [{ name: 'project', kind: 'directory' }],
          [`${CLAUDE_ROOT}/project`]: [{ name: 'foreign-claude.jsonl', kind: 'file' }],
          [CODEX_ROOT]: [{ name: '2026', kind: 'directory' }],
          [`${CODEX_ROOT}/2026`]: [{ name: '08', kind: 'directory' }],
          [`${CODEX_ROOT}/2026/08`]: [{ name: 'foreign-codex.jsonl', kind: 'file' }],
        },
        { [source]: `${validClaude}\n`, [codexSource]: `${validCodex}\n` },
      ),
    );

    const listing = await history.list();

    expect(listing.skipped).toEqual([]);
    expect(listing.conversations).toHaveLength(2);
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
    expect(listing.conversations.some(conversation => conversation.harness === 'codex')).toBe(true);
  });

  test("titles a conversation by the owner's first words, never the harness's own records", async () => {
    const source = `${CLAUDE_ROOT}/project/background.jsonl`;
    const record = (extra: Record<string, unknown>, content: string) =>
      JSON.stringify({ type: 'user', sessionId: 'background', message: { role: 'user', content }, ...extra });
    const lines = [
      record(
        { origin: { kind: 'task-notification' } },
        '<task-notification>\n<status>completed</status>\n</task-notification>',
      ),
      record({}, '<command-name>/clear</command-name>'),
      record({ origin: { kind: 'human' } }, '  Fix the   upload test  '),
    ];
    const titled = async (text: string) =>
      (
        await importer(
          new FixtureFiles(
            {
              [CLAUDE_ROOT]: [{ name: 'project', kind: 'directory' }],
              [`${CLAUDE_ROOT}/project`]: [{ name: 'background.jsonl', kind: 'file' }],
            },
            { [source]: text },
          ),
        ).list()
      ).conversations[0]?.title;

    expect(await titled(`${lines.join('\n')}\n`)).toBe('Fix the upload test');
    expect(await titled(`${lines.slice(0, 2).join('\n')}\n`)).toBe('background.jsonl');
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

  test('skips a transcript with no message in it rather than listing an empty conversation', async () => {
    const source = `${CLAUDE_ROOT}/project/bookkeeping.jsonl`;
    const history = importer(
      new FixtureFiles(
        {
          [CLAUDE_ROOT]: [{ name: 'project', kind: 'directory' }],
          [`${CLAUDE_ROOT}/project`]: [{ name: 'bookkeeping.jsonl', kind: 'file' }],
        },
        { [source]: `${JSON.stringify({ type: 'unrecognised-bookkeeping', sessionId: 'x' })}\n` },
      ),
    );

    await expect(history.list()).resolves.toEqual({
      conversations: [],
      skipped: [{ harness: 'claude', source, reason: 'the transcript contains no renderable messages' }],
    });
  });

  test('never lists a transcript whose parser reports a partial record, even with no issue named', async () => {
    const source = `${CLAUDE_ROOT}/project/partial.jsonl`;
    const real = new ClaudeTranscriptParser();
    const partial = new PacedTranscriptParser(
      {
        harness: real.harness,
        parse: (input: Parameters<ClaudeTranscriptParser['parse']>[0]) => ({
          ...real.parse(input),
          remainder: '{"type":"user"',
        }),
        parseRecord: real.parseRecord.bind(real),
        createInputObserver: real.createInputObserver.bind(real),
      },
      UNPACED,
    );
    const files = new FixtureFiles(
      {
        [CLAUDE_ROOT]: [{ name: 'project', kind: 'directory' }],
        [`${CLAUDE_ROOT}/project`]: [{ name: 'partial.jsonl', kind: 'file' }],
      },
      { [source]: `${validClaude}\n` },
    );
    const history = new ForeignHistoryImporter(
      files,
      { claudeProjects: CLAUDE_ROOT, codexSessions: CODEX_ROOT },
      new FileForeignTranscriptReader(files, {
        claude: partial,
        codex: new PacedTranscriptParser(new CodexTranscriptParser(), UNPACED),
      }),
    );

    await expect(history.list()).resolves.toEqual({
      conversations: [],
      skipped: [{ harness: 'claude', source, reason: 'the transcript ends with an incomplete record' }],
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

  test('skips a transcript too large to read whole, says how large, and never reads it', async () => {
    const source = `${CLAUDE_ROOT}/project/adopted.jsonl`;
    const unreadable = `${CLAUDE_ROOT}/project/vanished.jsonl`;
    const files = new FixtureFiles(
      {
        [CLAUDE_ROOT]: [{ name: 'project', kind: 'directory' }],
        [`${CLAUDE_ROOT}/project`]: [
          { name: 'adopted.jsonl', kind: 'file' },
          { name: 'vanished.jsonl', kind: 'file' },
        ],
      },
      { [source]: validClaude },
      { [source]: 200 * 1024 * 1024 },
    );
    const read: string[] = [];
    const text = files.text.bind(files);
    files.text = async file => {
      read.push(file);
      return await text(file);
    };

    await expect(importer(files).list()).resolves.toEqual({
      conversations: [],
      skipped: [
        { harness: 'claude', source, reason: 'the transcript is 200 MB, more than the 32 MB a history listing reads' },
        { harness: 'claude', source: unreadable, reason: 'the transcript could not be read' },
      ],
    });
    expect(read).toEqual([]);
  });
});

describe('FileForeignTranscriptReader', () => {
  const source = `${CLAUDE_ROOT}/project/foreign-claude.jsonl`;
  const reader = () =>
    new FileForeignTranscriptReader(new FixtureFiles({}, { [source]: `${validClaude}\n` }), {
      claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), UNPACED),
      codex: new PacedTranscriptParser(new CodexTranscriptParser(), UNPACED),
    });

  test('answers a row alone for a listing and the row with its events for a detail', async () => {
    const candidate = { harness: 'claude' as const, source };

    const listed = await reader().read(candidate, false);
    const detailed = await reader().read(candidate, true);

    if (!('conversation' in listed) || !('conversation' in detailed)) throw new Error('expected a conversation');
    expect(listed.events).toEqual([]);
    expect(listed.conversation.eventCount).toBe(1);
    expect(detailed.events).toHaveLength(1);
    expect(detailed.conversation).toEqual(listed.conversation);
  });
});

describe('ForeignHistoryImporter over a reader', () => {
  test('asks the reader for a row alone when it lists and for events when it opens one', async () => {
    const asked: boolean[] = [];
    const files = new FixtureFiles({ [CLAUDE_ROOT]: [{ name: 'a.jsonl', kind: 'file' }] }, {});
    const conversation = {
      id: idOf('claude', `${CLAUDE_ROOT}/a.jsonl`),
      harness: 'claude' as const,
      title: 'a',
      source: `${CLAUDE_ROOT}/a.jsonl`,
      eventCount: 0,
      readOnly: true as const,
    };
    const history = new ForeignHistoryImporter(
      files,
      { claudeProjects: CLAUDE_ROOT, codexSessions: CODEX_ROOT },
      {
        read: async (_candidate, withEvents) => {
          asked.push(withEvents);
          return { conversation, events: [] };
        },
      },
    );

    await history.list();
    await history.get(conversation.id);

    expect(asked).toEqual([false, true]);
  });
});

const idOf = (harness: string, source: string): string =>
  createHash('sha256').update(`${harness}\u0000${source}`, 'utf8').digest('base64url');
