import { describe, expect, test } from 'bun:test';
import { ConversationIndex } from '../../../daemon/links/lib/conversation-index.ts';
import { memorySqlite, PARSERS } from '../../support/history-tree.ts';

const ROWS = 2_000;
const WORDS = ['login', 'billing', 'refactor', 'invoice', 'deploy', 'cache', 'search', 'render', 'schema', 'upgrade'];

/** An index whose table holds `ROWS` synthetic rows, written by SQL (the updater's own reading is measured elsewhere). */
const synthetic = async () => {
  const sqlite = memorySqlite();
  const index = new ConversationIndex({
    sqlite: () => sqlite,
    sources: async () => [],
    ferretNames: async () => new Map(),
    parsers: PARSERS,
    nowMs: () => 0,
  });
  await index.refresh();
  const kinds = ['computer', 'ferret-home', 'pool'] as const;
  sqlite.transaction(() => {
    for (let i = 0; i < ROWS; i += 1) {
      const preview = `${WORDS[i % 10]} the ${WORDS[(i * 7) % 10]} module number ${i}`;
      const project = `/work/project-${i % 40}`;
      sqlite.run(
        `INSERT INTO conv (harness, kind, label, path, id, size, mtime_ms, scanned, head_sha, ok, project, file_title, index_title,
           title, ferret_id, ferret_name, preview, latest, first_at, last_at, turns, turns_at_least, model, hay)
         VALUES (?, ?, ?, ?, ?, 1000, ?, 1000, 'x', 1, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, 4, 0, NULL, ?)`,
        [
          i % 3 === 0 ? 'codex' : 'claude-code',
          kinds[i % 3],
          'src',
          `projects/p/${i}.jsonl`,
          // Every 5th row shares an id with an earlier one (the dedupe itself is proved in conversation-index.test.ts).
          `id-${i % 5 === 0 ? i - (i % 3) : i}`,
          1_770_000_000_000 + i * 60_000,
          project,
          preview,
          1_770_000_000_000 + i * 60_000,
          1_770_000_000_000 + i * 60_000,
          `\n\n${preview}\n\n${project}`.toLowerCase(),
        ],
      );
    }
  });
  return index;
};

describe('querying a big index', () => {
  test(`${ROWS} rows answer a two-word search with a floor date and a limit`, async () => {
    const index = await synthetic();
    const answer = index.query({
      words: ['login', 'module'],
      sinceMs: 1_770_000_000_000 + (ROWS / 2) * 60_000,
      limit: 20,
    });
    expect(answer.conversations.length).toBe(20);
    expect(answer.matched).toBeGreaterThan(20);
    // Newest first.
    const times = answer.conversations.map(each => Date.parse(each.row.lastActivityAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test('an unfiltered newest listing and a single-conversation lookup answer', async () => {
    const index = await synthetic();
    const newest = index.query({ limit: 20 });
    const found = index.get('claude-code', 'id-1');
    expect(newest.conversations).toHaveLength(20);
    expect(found?.row.id).toBe('id-1');
  });
});
