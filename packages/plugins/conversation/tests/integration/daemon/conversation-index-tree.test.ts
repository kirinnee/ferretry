import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationIndex, type IndexSource } from '../../../daemon/links/lib/conversation-index.ts';
import { diskHistory } from '../../support/disk-history.ts';
import { claudeRecord, codexRollout, memorySqlite, PARSERS } from '../../support/history-tree.ts';

const A = '3b1a4a52-0000-4000-8000-00000000000a';
const B = '3b1a4a52-0000-4000-8000-00000000000b';
const CODEX = '5c1e0e3a-0000-4000-8000-0000000000aa';
const talk = (user: string, at: string) =>
  `${claudeRecord('user', user, at)}\n${claudeRecord('assistant', 'ok', at)}\n`;

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const temp = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), 'conversation-index-'));
  folders.push(folder);
  return folder;
};

/** Claude's own home, a ferret's home and Codex's, as folders on disk. */
const world = async () => {
  const root = await temp();
  const claude = join(root, 'dot-claude');
  const scout = join(root, 'agent-homes', 'scout');
  const codex = join(root, 'dot-codex');
  await mkdir(join(claude, 'projects', '-work-app'), { recursive: true });
  await mkdir(join(scout, 'projects', '-work-app'), { recursive: true });
  await mkdir(join(codex, 'sessions', '2026', '10', '10'), { recursive: true });
  const sources: IndexSource[] = [
    { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: diskHistory(claude) },
    { harness: 'claude-code', parser: 'claude', kind: 'ferret-home', label: 'scout', files: diskHistory(scout) },
    { harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner', files: diskHistory(codex) },
  ];
  const index = new ConversationIndex({
    sqlite: () => memorySqlite(),
    sources: async () => sources,
    ferretNames: async () => new Map([[`claude-code:${B}`, { ferret: 'scout', name: 'Scout of billing' }]]),
    parsers: PARSERS,
    nowMs: () => 0,
  });
  return { root, claude, scout, codex, index };
};

describe('the conversation index over a folder tree', () => {
  test('lists every home’s conversations, follows appends, rewrites and deletions, and never writes a transcript', async () => {
    const { claude, scout, codex, index } = await world();
    const a = join(claude, 'projects', '-work-app', `${A}.jsonl`);
    const b = join(scout, 'projects', '-work-app', `${B}.jsonl`);
    const c = join(codex, 'sessions', '2026', '10', '10', `rollout-2026-10-10T09-00-00-${CODEX}.jsonl`);
    await writeFile(a, talk('please add a login page', '2026-02-01T09:00:00.000Z'));
    await writeFile(b, talk('check the invoices', '2026-02-02T09:00:00.000Z'));
    await writeFile(c, codexRollout(CODEX, '/work/notes', 'take notes'));
    // A link is never followed, and a sub-agent folder below a project is not a conversation.
    await symlink(a, join(claude, 'projects', '-work-app', 'alias.jsonl'));
    await mkdir(join(claude, 'projects', '-work-app', A));
    await writeFile(
      join(claude, 'projects', '-work-app', A, 'subagent.jsonl'),
      talk('sub', '2026-02-01T09:00:00.000Z'),
    );
    const before = await Promise.all(
      [a, b, c].map(async path => [(await stat(path)).size, (await stat(path)).mtimeMs]),
    );

    await index.refresh();
    const listed = index.query();
    expect(listed.matched).toBe(3);
    expect(listed.conversations.map(each => each.row.id)).toEqual([CODEX, B, A]);
    expect(index.query({ words: ['scout', 'billing'] }).conversations.map(each => each.row.id)).toEqual([B]);
    expect(index.query({ kinds: ['ferret-home'] }).conversations.map(each => each.row.id)).toEqual([B]);

    // Nothing was written to any transcript.
    expect(
      await Promise.all([a, b, c].map(async path => [(await stat(path)).size, (await stat(path)).mtimeMs])),
    ).toEqual(before);

    // An append is folded in.
    await appendFile(a, talk('and a logout button', '2026-02-03T09:00:00.000Z'));
    await index.refresh();
    expect(index.query({ words: ['logout'] }).conversations[0]?.row).toMatchObject({ id: A, turns: 2 });

    // A rewrite (same path, different beginning) is described afresh.
    await writeFile(a, talk('a different start', '2026-02-04T09:00:00.000Z'));
    await utimes(a, new Date('2026-02-04T09:00:00Z'), new Date('2026-02-04T09:00:00Z'));
    await index.refresh();
    expect(index.query({ words: ['different'] }).conversations[0]?.row).toMatchObject({
      id: A,
      preview: 'a different start',
      turns: 1,
    });
    expect(index.query({ words: ['logout'] }).matched).toBe(0);

    // A deletion drops the row.
    await rm(c);
    await index.refresh();
    expect(
      index
        .query()
        .conversations.map(each => each.row.id)
        .sort(),
    ).toEqual([A, B].sort());
  });

  test('a big transcript is described from its two ends, a middle skipped, and an append reads only the new bytes', async () => {
    const { claude, index } = await world();
    const path = join(claude, 'projects', '-work-app', `${A}.jsonl`);
    const body = Array.from({ length: 1500 }, (_, i) =>
      talk(`message ${i} ${'y'.repeat(1500)}`, '2026-02-01T09:00:00.000Z'),
    ).join('');
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024);
    await writeFile(path, body);
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({
      id: A,
      preview: expect.stringContaining('message 0 '),
      latest: expect.stringContaining('message 1499 '),
      turnsAtLeast: true,
    });
    await appendFile(path, talk('final word', '2026-02-09T09:00:00.000Z'));
    await index.refresh();
    expect(index.query().conversations[0]?.row.latest).toBe('final word');
  });
});
