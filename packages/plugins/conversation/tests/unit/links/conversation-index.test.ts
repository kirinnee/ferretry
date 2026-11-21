import { describe, expect, test } from 'bun:test';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexSource,
} from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, codexRollout, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

const A = '3b1a4a52-0000-4000-8000-00000000000a';
const B = '3b1a4a52-0000-4000-8000-00000000000b';
const CODEX = '5c1e0e3a-0000-4000-8000-0000000000aa';
const pathOf = (id: string) => `projects/-work-app/${id}.jsonl`;
const talk = (user: string, at: string, reply = 'done') =>
  `${claudeRecord('user', user, at)}\n${claudeRecord('assistant', reply, at)}\n`;

const setup = (names: () => FerretConversationNames = () => new Map()) => {
  const sqlite = memorySqlite();
  const owner = new MemoryHistory();
  const ferret = new MemoryHistory();
  const sources: IndexSource[] = [
    { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: owner },
    { harness: 'claude-code', parser: 'claude', kind: 'ferret-home', label: 'scout', files: ferret },
  ];
  let present = sources;
  let now = 0;
  const index = new ConversationIndex({
    sqlite: () => sqlite,
    sources: async () => present,
    ferretNames: async () => names(),
    parsers: PARSERS,
    nowMs: () => now,
  });
  return {
    index,
    sqlite,
    owner,
    ferret,
    tick: (ms: number) => {
      now += ms;
    },
    drop: (label: string) => {
      present = sources.filter(source => source.label !== label);
    },
  };
};

describe('the conversation index updater', () => {
  test('reads a new transcript once and lists it with what it says', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), talk('please add a login page', '2026-02-01T09:00:00.000Z', 'it is on /login'));
    await index.refresh();
    const answer = index.query();
    expect(answer.matched).toBe(1);
    expect(answer.conversations[0]?.row).toMatchObject({
      id: A,
      harness: 'claude-code',
      project: '/work/app',
      preview: 'please add a login page',
      turns: 1,
      keptIn: 'computer',
      // No title from the CLI: one from the first message, task-like, not the message itself.
      name: 'Add a Login Page',
      title: 'Add a Login Page',
    });
    expect(answer.conversations[0]?.row.lastActivityAt as string).toBe('2026-02-01T09:00:00.000Z');
  });

  test('an unchanged file is not read again', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), talk('hello there', '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    owner.resetReads();
    await index.refresh();
    expect(owner.bytesRead).toBe(0);
  });

  test('a file that only grew is read from where it was read to, and its row folds in the new records', async () => {
    const { index, owner } = setup();
    const first = talk('please add a login page', '2026-02-01T09:00:00.000Z');
    owner.set(pathOf(A), first);
    await index.refresh();
    owner.resetReads();
    const added = talk('now add a logout button', '2026-02-02T10:00:00.000Z');
    owner.append(pathOf(A), added);
    await index.refresh();
    // 4 KiB hash window plus the appended bytes: never the old body again.
    const total = owner.readByPath.get(pathOf(A)) ?? 0;
    expect(total).toBeLessThanOrEqual(new TextEncoder().encode(added).length + new TextEncoder().encode(first).length);
    expect(total).toBeLessThan(new TextEncoder().encode(first + added).length + 1);
    const row = index.query().conversations[0]?.row;
    expect(row).toMatchObject({
      preview: 'please add a login page',
      latest: 'now add a logout button',
      turns: 2,
      lastActivityAt: '2026-02-02T10:00:00.000Z',
    });
  });

  test('an append reads only the appended bytes of a large file', async () => {
    const { index, owner } = setup();
    const big = Array.from({ length: 900 }, (_, i) =>
      talk(`message number ${i} ${'x'.repeat(2000)}`, '2026-02-01T09:00:00.000Z'),
    ).join('');
    owner.set(pathOf(A), big);
    await index.refresh();
    owner.resetReads();
    const added = talk('the very last thing', '2026-02-03T00:00:00.000Z');
    owner.append(pathOf(A), added);
    await index.refresh();
    expect(owner.bytesRead).toBeLessThan(4096 + new TextEncoder().encode(added).length + 1);
    expect(index.query().conversations[0]?.row.latest).toBe('the very last thing');
    // The head and tail of a big file are what a first read takes; its turn count is a floor.
    expect(index.query().conversations[0]?.row.turnsAtLeast).toBe(true);
  });

  test('a rewritten file (a different beginning) is described afresh, not folded', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), talk('the original request', '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    owner.set(
      pathOf(A),
      `${talk('a completely different start', '2026-02-05T09:00:00.000Z')}${talk('and more', '2026-02-05T09:10:00.000Z')}`,
    );
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({
      preview: 'a completely different start',
      latest: 'and more',
      turns: 2,
    });
  });

  test('a file that vanished loses its row, and a source that vanished loses its rows', async () => {
    const { index, owner, ferret, drop } = setup();
    owner.set(pathOf(A), talk('first conversation', '2026-02-01T09:00:00.000Z'));
    ferret.set(pathOf(B), talk('second conversation', '2026-02-02T09:00:00.000Z'));
    await index.refresh();
    expect(index.query().matched).toBe(2);
    owner.remove(pathOf(A));
    await index.refresh();
    expect(index.query().conversations.map(each => each.row.id)).toEqual([B]);
    drop('scout');
    await index.refresh();
    expect(index.query().matched).toBe(0);
  });

  test('the same conversation in two places is listed once: the newest copy wins, and says it is also on the computer', async () => {
    const { index, owner, ferret } = setup();
    owner.set(pathOf(A), talk('shared work', '2026-02-01T09:00:00.000Z'));
    ferret.set(
      pathOf(A),
      `${talk('shared work', '2026-02-01T09:00:00.000Z')}${talk('shared work continued', '2026-02-04T09:00:00.000Z')}`,
    );
    await index.refresh();
    const answer = index.query();
    expect(answer.matched).toBe(1);
    expect(answer.conversations[0]).toMatchObject({ kind: 'ferret-home', label: 'scout' });
    expect(answer.conversations[0]?.row).toMatchObject({ keptIn: 'ferretry', alsoOnComputer: true, turns: 2 });
    // Asked for the computer's alone, its own copy is the one listed.
    const computer = index.query({ kinds: ['computer'] });
    expect(computer.conversations[0]).toMatchObject({ kind: 'computer', label: 'owner' });
    expect(computer.conversations[0]?.row.alsoOnComputer).toBeUndefined();
  });

  test('a search needs every word, as a substring, in any case; since is a floor; newest first; limit cuts, matched counts', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), talk('Please ADD a login page', '2026-02-01T09:00:00.000Z'));
    owner.set(pathOf(B), talk('refactor the billing module', '2026-03-01T09:00:00.000Z'));
    await index.refresh();
    expect(index.query({ words: ['login', 'page'] }).matched).toBe(1);
    expect(index.query({ words: ['login', 'billing'] }).matched).toBe(0);
    expect(index.query({ words: ['gin pa'.split(' ')[0] as string] }).matched).toBe(1);
    expect(index.query({ words: ['/work/app'] }).matched).toBe(2);
    expect(index.query({ sinceMs: Date.parse('2026-02-15T00:00:00Z') }).conversations.map(each => each.row.id)).toEqual(
      [B],
    );
    const all = index.query({ limit: 1 });
    expect(all.matched).toBe(2);
    expect(all.conversations.map(each => each.row.id)).toEqual([B]);
  });

  test('a transcript that says nothing the owner said is counted as skipped, not listed, and not read again', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), `${claudeRecord('assistant', 'unprompted', '2026-02-01T09:00:00.000Z')}\n`);
    await index.refresh();
    expect(index.query()).toMatchObject({ matched: 0, skipped: 1 });
    owner.resetReads();
    await index.refresh();
    expect(owner.bytesRead).toBe(0);
  });

  test('the transcripts it could not read are counted per harness, and a harness filter counts only its own', async () => {
    const sqlite = memorySqlite();
    const claude = new MemoryHistory();
    const codex = new MemoryHistory();
    claude.set(pathOf(A), `${claudeRecord('assistant', 'unprompted', '2026-02-01T09:00:00.000Z')}\n`);
    claude.set(pathOf(B), `${claudeRecord('assistant', 'also unprompted', '2026-02-01T09:00:00.000Z')}\n`);
    codex.set(
      `sessions/2026/10/10/rollout-2026-10-10T09-00-00-${CODEX}.jsonl`,
      `${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-10T09:00:00.000Z', payload: { id: CODEX, cwd: '/w' } })}\n`,
    );
    const index = new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => [
        { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: claude },
        { harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner', files: codex },
      ],
      ferretNames: async () => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
    });
    await index.refresh();
    expect(index.query()).toMatchObject({ skipped: 3, skippedBy: { 'claude-code': 2, codex: 1 } });
    expect(index.query({ harness: 'codex' })).toMatchObject({ skipped: 1, skippedBy: { codex: 1 } });
  });

  test('a custom title names the conversation, and a rename appended later is picked up', async () => {
    const { index, owner } = setup();
    const title = (name: string) => `${JSON.stringify({ type: 'custom-title', customTitle: name })}\n`;
    owner.set(pathOf(A), talk('add a login page', '2026-02-01T09:00:00.000Z') + title('Login work'));
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ name: 'Login work', title: 'Login work' });
    owner.append(pathOf(A), title('Login and logout'));
    await index.refresh();
    expect(index.query({ words: ['logout'] }).conversations[0]?.row.title).toBe('Login and logout');
  });

  test('Codex rollouts are listed and named by Codex’s own session index, which a later edit of the index renames', async () => {
    const sqlite = memorySqlite();
    const home = new MemoryHistory();
    home.set(
      `sessions/2026/10/10/rollout-2026-10-10T09-00-00-${CODEX}.jsonl`,
      codexRollout(CODEX, '/work/notes', 'take notes'),
    );
    home.set('session_index.jsonl', `${JSON.stringify({ id: CODEX, thread_name: 'Meeting notes' })}\n`);
    home.set('sessions/a/b/c/d/e/rollout-too-deep.jsonl', 'x');
    const index = new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => [{ harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner', files: home }],
      ferretNames: async () => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
    });
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({
      id: CODEX,
      harness: 'codex',
      name: 'Meeting notes',
      preview: 'take notes',
    });
    home.set('session_index.jsonl', `${JSON.stringify({ id: CODEX, thread_name: 'Renamed notes' })}\n`);
    await index.refresh();
    expect(index.query({ words: ['renamed'] }).matched).toBe(1);
    expect(index.query({ words: ['meeting'] }).matched).toBe(0);
  });
});

describe('big and awkward files', () => {
  const filler = (bytes: number) =>
    Array.from(
      { length: Math.ceil(bytes / 1000) },
      () => claudeRecord('assistant', 'w'.repeat(900), '2026-02-01T09:00:00.000Z') + '\n',
    ).join('');

  test('a tail with nothing the owner said is widened until it holds the latest message', async () => {
    const { index, owner } = setup();
    owner.set(
      pathOf(A),
      talk('the first request', '2026-02-01T09:00:00.000Z') +
        filler(300_000) +
        talk('a message deep in the middle', '2026-02-02T09:00:00.000Z') +
        filler(300_000),
    );
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({
      preview: 'the first request',
      latest: 'a message deep in the middle',
    });
  });

  test('a first record too large for the head is found by one wider look at the beginning', async () => {
    const { index, owner } = setup();
    owner.set(
      pathOf(A),
      `${claudeRecord('user', `${'q'.repeat(400_000)}`, '2026-02-01T09:00:00.000Z')}\n${filler(300_000)}`,
    );
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ id: A, turns: 1 });
    expect(index.query().conversations[0]?.row.preview.startsWith('qqqq')).toBe(true);
  });

  test('a failing source list, or a transcript that cannot be parsed, is said once and never breaks the update', async () => {
    const warnings: string[] = [];
    const owner = new MemoryHistory();
    owner.set(pathOf(A), talk('hello there', '2026-02-01T09:00:00.000Z'));
    const source: IndexSource = {
      harness: 'claude-code',
      parser: 'claude',
      kind: 'computer',
      label: 'owner',
      files: owner,
    };
    const broken = new ConversationIndex({
      sqlite: () => memorySqlite(),
      sources: async () => Promise.reject(new Error('no sources')),
      ferretNames: async () => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
      warn: message => void warnings.push(message),
    });
    await broken.refresh();
    expect(warnings).toEqual(['The conversation index could not be updated: no sources']);
    const unparsable = new ConversationIndex({
      sqlite: () => memorySqlite(),
      sources: async () => [source],
      ferretNames: async () => new Map(),
      parsers: { ...PARSERS, claude: { parse: async () => Promise.reject(new Error('bad parse')) } },
      nowMs: () => 0,
      warn: message => void warnings.push(message),
    });
    await unparsable.refresh();
    expect(warnings.at(-1)).toBe('A transcript could not be indexed: bad parse');
    expect(unparsable.query().matched).toBe(0);
  });

  test('a listing can be narrowed to one harness, and a listed conversation names the tree its file is in', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), talk('hello there', '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    expect(index.query({ harness: 'claude-code' }).matched).toBe(1);
    expect(index.query({ harness: 'codex' }).matched).toBe(0);
    const found = index.get('claude-code', A);
    expect(found && index.sourceOf(found)?.label).toBe('owner');
    expect(index.sourceOf({ harness: 'codex', kind: 'computer', label: 'owner' })).toBeUndefined();
  });
});

describe('a conversation whose every message is a hand-off pointer (a ferret’s)', () => {
  const pointer = (n: number) =>
    `Read the file /home/x/.ferretry/state/ferrets/sessions/scout/turns/turn-00${n}.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`;

  test('is listed by its pointer line, found by its ferret’s name, and its later turns are counted', async () => {
    const names = new Map([
      [
        `claude-code:${A}`,
        { ferret: 'scout', name: 'Scout', title: 'Billing code audit', titleSource: 'owner' as const },
      ],
    ]);
    const { index, owner } = setup(() => names);
    owner.set(pathOf(A), talk(pointer(1), '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    expect(index.query({ words: ['scout', 'billing'] }).conversations[0]?.row).toMatchObject({
      id: A,
      // The ferret's own title is the name: no callsign leads it.
      name: 'Billing code audit',
      ferretName: 'Scout',
      turns: 1,
      preview: expect.stringContaining('turn-001.md'),
    });
    owner.append(pathOf(A), talk(pointer(2), '2026-02-02T09:00:00.000Z'));
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({
      turns: 2,
      latest: expect.stringContaining('turn-002.md'),
    });
  });

  test('a conversation with real messages is still described by them, not by its pointer', async () => {
    const { index, owner } = setup();
    owner.set(
      pathOf(A),
      talk(pointer(1), '2026-02-01T09:00:00.000Z') + talk('and now the real question', '2026-02-01T09:10:00.000Z'),
    );
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ preview: 'and now the real question', turns: 1 });
  });
});

describe('names: the owner’s title, then the conversation’s own, then one made from its first message', () => {
  test('a pointer-only conversation of a ferret with no title goes by its folder, not by the pointer line', async () => {
    const names = new Map([[`claude-code:${A}`, { ferret: 'scout', name: 'Scout' }]]);
    const { index, owner } = setup(() => names);
    const line =
      'Read the file /home/x/.ferretry/state/ferrets/sessions/scout/turns/turn-001.md now, then carefully follow every instruction inside it. This is your complete task for this turn.';
    owner.set(pathOf(A), talk(line, '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('app');
  });

  test('a conversation a ferret runs is found by the ferret’s name, and the CLI’s title is the name', async () => {
    const names = new Map([[`claude-code:${A}`, { ferret: 'scout', name: 'Scout the billing code' }]]);
    const { index, owner } = setup(() => names);
    owner.set(
      pathOf(A),
      talk('look at invoices', '2026-02-01T09:00:00.000Z') +
        `${JSON.stringify({ type: 'custom-title', customTitle: 'Invoice dig' })}\n`,
    );
    owner.set(pathOf(B), talk('something unrelated', '2026-02-02T09:00:00.000Z'));
    await index.refresh();
    const found = index.query({ words: ['scout', 'billing'] });
    expect(found.matched).toBe(1);
    expect(found.conversations[0]?.row).toMatchObject({
      id: A,
      ferret: 'scout',
      ferretName: 'Scout the billing code',
      title: 'Invoice dig',
      // The callsign never leads the name, and no "— title" is joined to it.
      name: 'Invoice dig',
    });
    // Its title is searchable too, and a conversation no ferret runs is named by a title made from its first message.
    expect(index.query({ words: ['invoice', 'dig'] }).matched).toBe(1);
    expect(index.query({ words: ['unrelated'] }).conversations[0]?.row.name).toBe('Something Unrelated');
  });

  test('the ferret name is only a name: a title equal to it is said once', async () => {
    const names = new Map([[`claude-code:${A}`, { ferret: 'scout', name: 'Invoice dig' }]]);
    const { index, owner } = setup(() => names);
    owner.set(
      pathOf(A),
      talk('look at invoices', '2026-02-01T09:00:00.000Z') +
        `${JSON.stringify({ type: 'custom-title', customTitle: 'Invoice dig' })}\n`,
    );
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('Invoice dig');
  });

  test('a renamed ferret’s new title is on the next listing, and the old one finds nothing', async () => {
    let title = 'Scout one';
    const { index, owner } = setup(
      () => new Map([[`claude-code:${A}`, { ferret: 'scout', name: 'Scout', title, titleSource: 'owner' as const }]]),
    );
    owner.set(pathOf(A), talk('look at invoices', '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    expect(index.query({ words: ['one'] }).conversations[0]?.row.name).toBe('Scout one');
    title = 'Billing helper';
    owner.resetReads();
    await index.refresh();
    expect(owner.bytesRead).toBe(0);
    expect(index.query({ words: ['billing', 'helper'] }).conversations[0]?.row.name).toBe('Billing helper');
    expect(index.query({ words: ['one'] }).matched).toBe(0);
  });

  test('a ferret that no longer runs the conversation (or is gone) stops naming it', async () => {
    let names: FerretConversationNames = new Map([[`claude-code:${A}`, { ferret: 'scout', name: 'Scout' }]]);
    const { index, owner } = setup(() => names);
    owner.set(pathOf(A), talk('look at invoices', '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    expect(index.query({ words: ['scout'] }).matched).toBe(1);
    names = new Map();
    await index.refresh();
    expect(index.query({ words: ['scout'] }).matched).toBe(0);
    expect(index.query().conversations[0]?.row.ferretName).toBeUndefined();
  });
});

describe('when a listing waits', () => {
  test('a listing never waits on a first build, and says the index is still being read', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), talk('hello', '2026-02-01T09:00:00.000Z'));
    const first = await index.ready();
    expect(first.indexing).toBe(true);
    expect(index.query().matched).toBe(0);
    await index.refresh();
    expect((await index.ready()).indexing).toBe(false);
    expect(index.query().matched).toBe(1);
  });

  test('once built, a listing reuses a refresh younger than 5 s and refreshes an older one', async () => {
    const { index, owner, tick } = setup();
    owner.set(pathOf(A), talk('hello', '2026-02-01T09:00:00.000Z'));
    await index.refresh();
    owner.set(pathOf(B), talk('a second one', '2026-02-02T09:00:00.000Z'));
    tick(2000);
    await index.ready();
    expect(index.query().matched).toBe(1);
    tick(4000);
    await index.ready();
    expect(index.query().matched).toBe(2);
  });
});

describe('review round 1: records, names and duplicates while the index is written', () => {
  const AT = '2026-02-01T09:00:00.000Z';
  const rollout = (id: string) => `sessions/2026/10/10/rollout-2026-10-10T09-00-00-${id}.jsonl`;
  const codexSetup = () => {
    const sqlite = memorySqlite();
    const home = new MemoryHistory();
    const index = new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => [{ harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner', files: home }],
      ferretNames: async () => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
    });
    return { index, home };
  };
  const codexMessage = (text: string) =>
    `${JSON.stringify({
      type: 'response_item',
      timestamp: AT,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })}\n`;

  test('a last record whose newline has not been written yet is counted once, when its newline and the next record arrive', async () => {
    const { index, owner } = setup();
    owner.set(pathOf(A), `${claudeRecord('user', 'first', AT)}\n${claudeRecord('user', 'second', AT)}`);
    await index.refresh();
    expect(index.query().conversations[0]?.row.turns).toBe(2);
    owner.append(pathOf(A), `\n${claudeRecord('user', 'third', AT)}\n`);
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ turns: 3, latest: 'third' });
  });

  test('a half-written last record is left out until the rest of it arrives, then counted once', async () => {
    const { index, owner } = setup();
    const second = claudeRecord('user', 'second', AT);
    owner.set(pathOf(A), `${claudeRecord('user', 'first', AT)}\n${second.slice(0, 30)}`);
    await index.refresh();
    expect(index.query().conversations[0]?.row.turns).toBe(1);
    owner.append(pathOf(A), `${second.slice(30)}\n`);
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ turns: 2, latest: 'second' });
  });

  test('an unterminated last record of a large file (read from its two ends) is counted once too', async () => {
    const { index, owner } = setup();
    const big = claudeRecord('assistant', 'x'.repeat(2 * 1024 * 1024), AT);
    owner.set(
      pathOf(A),
      `${claudeRecord('user', 'first', AT)}\n${big}\n${big}\n${big}\n${claudeRecord('user', 'second', AT)}`,
    );
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ turnsAtLeast: true, latest: 'second' });
    const before = index.query().conversations[0]?.row.turns ?? 0;
    owner.append(pathOf(A), `\n${claudeRecord('user', 'third', AT)}\n`);
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ turns: before + 1, latest: 'third' });
  });

  test('a Codex thread renamed in the same refresh its rollout grew keeps the new name', async () => {
    const { index, home } = codexSetup();
    home.set(rollout(CODEX), codexRollout(CODEX, '/work/app', 'first'));
    home.set('session_index.jsonl', `${JSON.stringify({ id: CODEX, thread_name: 'Old name' })}\n`);
    await index.refresh();
    home.append(rollout(CODEX), codexMessage('second'));
    home.set('session_index.jsonl', `${JSON.stringify({ id: CODEX, thread_name: 'New name' })}\n`);
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ title: 'New name', turns: 2, latest: 'second' });
    await index.refresh();
    expect(index.query({ words: ['new', 'name'] }).matched).toBe(1);
    expect(index.query({ words: ['old', 'name'] }).matched).toBe(0);
  });

  test('a Codex session name is looked up by the id the rollout records, not the one its file name carries', async () => {
    const { index, home } = codexSetup();
    home.set(rollout(CODEX), codexRollout(B, '/work/app', 'first'));
    home.set('session_index.jsonl', `${JSON.stringify({ id: B, thread_name: 'Actual title' })}\n`);
    await index.refresh();
    expect(index.query().conversations[0]?.row).toMatchObject({ id: B, title: 'Actual title' });
  });

  test('a listing during a refresh does not show a conversation twice because its other copy is already indexed', async () => {
    const sqlite = memorySqlite();
    const owner = new MemoryHistory();
    const ferret = new MemoryHistory();
    const ids = Array.from({ length: 32 }, (_, i) => `3b1a4a52-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const id of ids)
      for (const home of [owner, ferret]) home.set(pathOf(id), `${claudeRecord('user', 'first', AT)}\n`);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let reached!: () => void;
    const paused = new Promise<void>(resolve => (reached = resolve));
    let held = false;
    const index = new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => [
        { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: owner },
        { harness: 'claude-code', parser: 'claude', kind: 'ferret-home', label: 'scout', files: ferret },
      ],
      ferretNames: async () => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
      yieldToLoop: async () => {
        const rows = sqlite.query<{ n: number }>('SELECT count(*) AS n FROM conv')[0]?.n ?? 0;
        if (!held && rows >= 64) {
          held = true;
          reached();
          await gate;
        }
      },
    });
    const run = index.refresh();
    await paused;
    const during = index.query();
    release();
    await run;
    expect(during.matched).toBe(32);
    expect(during.conversations).toHaveLength(32);
    expect(index.query().matched).toBe(32);
  });
});
