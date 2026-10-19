/**
 * Keeping existing conversations as ferrets: discovery over a fake, read-only file port and the real
 * parsers, the daemon-side search, and the adoption rules (duplicates, refusals, one at a time).
 *
 * Every file here is an invented fixture held in memory. No real CLI home is read.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  adoptedConversationFile,
  adoptedTranscriptProvenance,
  type ConversationAdopter,
  type ConversationAdoption,
  type ConversationFileEntry,
  type ConversationFiles,
  ConversationImportService,
  type ConversationRoot,
  conversationHead,
  conversationKey,
  conversationLinkFailure,
  conversationResumeArguments,
} from '../../../src/lib/imports/index.ts';
import { ClaudeTranscriptParser, CodexTranscriptParser } from '../../../src/lib/transcript/index.ts';

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CLAUDE_OLD = '22222222-2222-4222-8222-222222222222';
const CODEX_ID = '33333333-3333-4333-8333-333333333333';

const claude = (text: string, at: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'user',
    sessionId: CLAUDE_ID,
    cwd: '/work/shop',
    timestamp: at,
    message: { role: 'user', content: text },
    ...extra,
  });
const claudeReply = (at: string): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: CLAUDE_ID,
    cwd: '/work/shop',
    timestamp: at,
    message: {
      id: 'msg-1',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
const codexMeta = JSON.stringify({
  type: 'session_meta',
  timestamp: '2026-10-10T09:00:00.000Z',
  payload: { id: CODEX_ID, cwd: '/work/notes' },
});
const codexUser = (text: string, at: string): string =>
  JSON.stringify({
    type: 'response_item',
    timestamp: at,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });

/** A tree of fixture files: directories are objects, files are strings. */
type Tree = { readonly [name: string]: Tree | string | null };

class FakeFiles implements ConversationFiles {
  reads = 0;
  constructor(
    private readonly tree: Tree,
    private readonly mtimes: Readonly<Record<string, number>> = {},
  ) {}

  private node(path: string): Tree | string | null | undefined {
    let current: Tree | string | null | undefined = this.tree;
    for (const part of path.split('/').filter(segment => segment !== '')) {
      if (current === undefined || current === null || typeof current === 'string') return undefined;
      current = current[part];
    }
    return current;
  }

  async entries(directory: string): Promise<readonly ConversationFileEntry[]> {
    const node = this.node(directory);
    if (node === undefined || node === null || typeof node === 'string') return [];
    return Object.entries(node).map(([name, child]) => ({
      name,
      kind: child === null ? 'other' : typeof child === 'string' ? 'file' : 'directory',
    }));
  }

  async info(file: string) {
    const node = this.node(file);
    return typeof node === 'string'
      ? { modifiedAtMs: this.mtimes[file] ?? 1_700_000_000_000, size: node.length }
      : undefined;
  }

  async text(file: string): Promise<string | undefined> {
    this.reads += 1;
    const node = this.node(file);
    return typeof node === 'string' && !node.startsWith('UNREADABLE') ? node : undefined;
  }

  readonly heads: { readonly file: string; readonly maxBytes: number }[] = [];

  async head(file: string, maxBytes: number): Promise<string | undefined> {
    this.heads.push({ file, maxBytes });
    const node = this.node(file);
    return typeof node === 'string' ? node.slice(0, maxBytes) : undefined;
  }
}

const parsers = { claude: new ClaudeTranscriptParser(), codex: new CodexTranscriptParser() };

const tree: Tree = {
  host: {
    claude: {
      projects: {
        '-work-shop': {
          [`${CLAUDE_ID}.jsonl`]: [
            claude('<command-name>/clear</command-name>', '2026-10-17T08:00:00.000Z'),
            claude('Fix   the\ncart total', '2026-10-17T08:01:00.000Z'),
            claudeReply('2026-10-17T08:02:00.000Z'),
            claude('Now ship it', '2026-10-17T08:03:00.000Z'),
            '{"type":"user"',
          ].join('\n'),
          [`${CLAUDE_OLD}.jsonl`]: claude('An old one', 'not-a-time', { sessionId: CLAUDE_OLD }),
          'not-an-id!.jsonl': claude('Bad name', '2026-10-17T08:00:00.000Z'),
          'notes.txt': 'ignored',
          [CLAUDE_ID]: { subagents: { 'agent-1.jsonl': claude('A sub-agent', '2026-10-17T08:00:00.000Z') } },
        },
        '-work-empty': {
          'nofolder.jsonl': JSON.stringify({ type: 'user', message: { role: 'user', content: 'no cwd' } }),
          'silent.jsonl': JSON.stringify({ type: 'user', cwd: '/work/empty', message: { role: 'user', content: '' } }),
          'unreadable.jsonl': 'UNREADABLE',
        },
        'stray-file.jsonl': 'not in a project folder',
        linked: null,
      },
    },
    codex: {
      sessions: {
        '2026': {
          '10': {
            '10': {
              [`rollout-2026-10-10T09-00-00-${CODEX_ID}.jsonl`]: [
                codexMeta,
                'not json',
                '42',
                codexUser('Draft the release notes', '2026-10-10T09:01:00.000Z'),
              ].join('\n'),
              'other.jsonl': codexUser('not a rollout', '2026-10-10T09:01:00.000Z'),
            },
          },
        },
      },
    },
  },
  pool: {
    claude: {
      projects: {
        '-work-shop': {
          [`${CLAUDE_ID}.jsonl`]: [claude('Fix the cart total', '2026-10-17T08:01:00.000Z')].join('\n'),
        },
      },
    },
  },
};

const ROOTS: readonly ConversationRoot[] = [
  { harness: 'claude', home: '/pool/claude', source: 'ferretry' },
  { harness: 'claude', home: '/host/claude', source: 'computer' },
  { harness: 'codex', home: '/host/codex', source: 'computer' },
];

class RecordingAdopter implements ConversationAdopter {
  readonly calls: ConversationAdoption[] = [];
  constructor(private readonly answer: (adoption: ConversationAdoption) => Promise<unknown> = async () => undefined) {}

  async adopt(adoption: ConversationAdoption) {
    this.calls.push(adoption);
    const answered = await this.answer(adoption);
    return (
      (answered as Awaited<ReturnType<ConversationAdopter['adopt']>> | undefined) ?? {
        kind: 'adopted' as const,
        session: `s-${this.calls.length}`,
        name: 'Mika',
        status: adoption.start ? ('running' as const) : ('stopped' as const),
      }
    );
  }
}

const subject = (
  owners: ReadonlyMap<string, string> = new Map(),
  adopter: ConversationAdopter = new RecordingAdopter(),
  files: FakeFiles = new FakeFiles(tree),
) => new ConversationImportService(files, ROOTS, parsers, { owners: async () => owners }, adopter);

describe('conversation discovery', () => {
  it('should describe each conversation once, newest first, from the first home that holds it', async () => {
    // Act
    const listing = await subject().list();

    // Assert
    should(listing.conversations.map(row => [row.harness, row.id])).deepEqual([
      ['claude', CLAUDE_ID],
      ['codex', CODEX_ID],
      ['claude', CLAUDE_OLD],
    ]);
    // The pool's copy of the name wins over the owner's own, so its (shorter) description is used.
    should(listing.conversations[0]).deepEqual({
      id: CLAUDE_ID,
      harness: 'claude',
      project: '/work/shop',
      preview: 'Fix the cart total',
      lastActivityAt: '2026-10-17T08:01:00.000Z',
      turns: 1,
    });
    should(listing.conversations[1]).containDeep({ project: '/work/notes', preview: 'Draft the release notes' });
    // A conversation with no usable time falls back to its file's.
    should(listing.conversations[2]?.lastActivityAt).equal(new Date(1_700_000_000_000).toISOString());
    should(listing.matched).equal(3);
    // The bad name, the folderless, the silent and the unreadable file; never the stray, link or sub-agent.
    should(listing.skipped).equal(4);
  });

  it('should keep the latest message, the turn count and the model when they are there', async () => {
    // Act
    const listing = await new ConversationImportService(
      new FakeFiles(tree),
      [{ harness: 'claude', home: '/host/claude', source: 'computer' }],
      parsers,
      { owners: async () => new Map() },
      new RecordingAdopter(),
    ).list({ harness: 'claude' });

    // Assert
    should(listing.conversations[0]).deepEqual({
      id: CLAUDE_ID,
      harness: 'claude',
      project: '/work/shop',
      preview: 'Fix the cart total',
      latest: 'Now ship it',
      lastActivityAt: '2026-10-17T08:03:00.000Z',
      turns: 2,
      model: 'claude-sonnet-4-5',
    });
  });

  it('should search the preview, the latest message and the folder, with a date floor and a limit', async () => {
    // Arrange
    const service = subject(new Map([[conversationKey('codex', CODEX_ID), 's-9']]));

    // Act
    const byWords = await service.list({ q: 'CART fix' });
    const byFolder = await service.list({ q: 'notes' });
    const recent = await service.list({ since: '2026-10-15T00:00:00.000Z' });
    const limited = await service.list({ limit: 1 });
    const codexOnly = await service.list({ harness: 'codex' });

    // Assert
    should(byWords.conversations.map(row => row.id)).deepEqual([CLAUDE_ID]);
    should(byFolder.conversations.map(row => row.id)).deepEqual([CODEX_ID]);
    should(byFolder.conversations[0]?.adoptedBy).equal('s-9');
    should(recent.conversations.map(row => row.id)).deepEqual([CLAUDE_ID]);
    should([limited.conversations.length, limited.matched]).deepEqual([1, 3]);
    should(codexOnly.conversations.map(row => row.harness)).deepEqual(['codex']);
  });

  it('should not re-read a file whose size and time are unchanged', async () => {
    // Arrange
    const files = new FakeFiles(tree);
    const service = subject(new Map(), new RecordingAdopter(), files);
    await service.list();
    const first = files.reads;

    // Act
    await service.list();

    // Assert
    should(files.reads).equal(first);
  });

  it('should read the folder and Codex id from the head of a transcript', () => {
    // Act & Assert
    should(conversationHead('codex', codexMeta)).deepEqual({ project: '/work/notes', id: CODEX_ID });
    should(conversationHead('claude', claude('x', '2026-10-17T08:00:00.000Z'))).deepEqual({
      project: '/work/shop',
      id: undefined,
    });
    should(conversationHead('codex', JSON.stringify({ type: 'response_item', payload: { cwd: '/x' } }))).be.undefined();
    should(conversationHead('codex', JSON.stringify({ type: 'session_meta', payload: null }))).be.undefined();
    should(conversationHead('claude', '\n{"cwd":"relative"}\n')).be.undefined();
  });
});

describe('conversation adoption', () => {
  it('should adopt each chosen conversation with its file, folder and start choice', async () => {
    // Arrange
    const adopter = new RecordingAdopter();

    // Act
    const result = await subject(new Map(), adopter).adopt({
      harness: 'claude',
      runtime: 'claude-default',
      conversations: [{ id: CLAUDE_ID, start: true }, { id: CLAUDE_OLD }],
    });

    // Assert
    should(result).deepEqual({
      adopted: [
        { id: CLAUDE_ID, session: 's-1', name: 'Mika', status: 'running' },
        { id: CLAUDE_OLD, session: 's-2', name: 'Mika', status: 'stopped' },
      ],
      refused: [],
    });
    should(adopter.calls[0]).containDeep({
      harness: 'claude',
      runtime: 'claude-default',
      start: true,
      conversation: {
        source: `/pool/claude/projects/-work-shop/${CLAUDE_ID}.jsonl`,
        relativePath: `projects/-work-shop/${CLAUDE_ID}.jsonl`,
        project: '/work/shop',
      },
    });
  });

  it('should refuse a missing conversation and one a session already keeps, and report a failed adoption', async () => {
    // Arrange
    const adopter = new RecordingAdopter(async adoption => {
      if (adoption.conversation.id === CLAUDE_OLD) throw new Error('the pane would not open');
      return undefined;
    });
    const owners = new Map([[conversationKey('claude', CLAUDE_ID), 's-7']]);

    // Act
    const result = await subject(owners, adopter).adopt({
      harness: 'claude',
      runtime: 'claude-default',
      conversations: [{ id: CLAUDE_ID }, { id: 'missing' }, { id: CLAUDE_OLD }],
    });

    // Assert
    should(result.adopted).deepEqual([]);
    should(result.refused).deepEqual([
      { id: CLAUDE_ID, code: 'already_adopted', reason: 'Session s-7 already keeps it.' },
      { id: 'missing', code: 'not_found', reason: 'No Claude Code conversation missing is on this machine.' },
      { id: CLAUDE_OLD, code: 'failed', reason: 'the pane would not open' },
    ]);
  });

  it('should pass on the adopter refusal and word a failure that carried no message', async () => {
    // Arrange
    const adopter = new RecordingAdopter(async adoption => {
      if (adoption.harness === 'codex') throw new Error('');
      return { kind: 'refused', code: 'harness_mismatch', reason: 'claude-default runs Claude Code.' };
    });

    // Act
    const codex = await subject(new Map(), adopter).adopt({
      harness: 'codex',
      runtime: 'codex-default',
      conversations: [{ id: CODEX_ID }],
    });
    const mismatch = await subject(new Map(), adopter).adopt({
      harness: 'claude',
      runtime: 'codex-default',
      conversations: [{ id: CLAUDE_ID }],
    });

    // Assert
    should(codex.refused).deepEqual([{ id: CODEX_ID, code: 'failed', reason: 'The ferret could not be created.' }]);
    should(mismatch.refused).deepEqual([
      { id: CLAUDE_ID, code: 'harness_mismatch', reason: 'claude-default runs Claude Code.' },
    ]);
  });

  it('should run one adoption at a time, so a second cannot keep what the first just kept', async () => {
    // Arrange
    const owners = new Map<string, string>();
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const adopter = new RecordingAdopter(async adoption => {
      await gate;
      owners.set(conversationKey(adoption.harness, adoption.conversation.id), 's-1');
      return undefined;
    });
    const service = subject(owners, adopter);
    const request = { harness: 'claude' as const, runtime: 'claude-default', conversations: [{ id: CLAUDE_ID }] };

    // Act
    const first = service.adopt(request);
    const second = service.adopt(request);
    release();
    const results = await Promise.all([first, second]);

    // Assert
    should(results[0].adopted).have.length(1);
    should(results[1].refused.map(item => item.code)).deepEqual(['already_adopted']);
  });

  it('should keep serving after an adoption request is refused outright', async () => {
    // Arrange
    const service = subject();

    // Act
    const refused = await service
      .adopt({ harness: 'claude', runtime: 'x', conversations: [] })
      .then(() => 'accepted')
      .catch(() => 'refused');
    const next = await service.adopt({ harness: 'claude', runtime: 'x', conversations: [{ id: CLAUDE_ID }] });

    // Assert
    should(refused).equal('refused');
    should(next.adopted).have.length(1);
  });
});

describe('what adopting a conversation decides', () => {
  it('should resume with each CLI’s own resume path', () => {
    // Act & Assert
    should(conversationResumeArguments('claude', CLAUDE_ID)).deepEqual(['--resume', CLAUDE_ID]);
    should(conversationResumeArguments('codex', CODEX_ID)).deepEqual(['resume', CODEX_ID]);
  });

  it('should record the runtime’s own name for the file, as adopted', () => {
    // Arrange
    const conversation = {
      id: CLAUDE_ID,
      harness: 'claude' as const,
      project: '/work/shop',
      preview: 'Fix',
      lastActivityAt: '2026-10-17T08:01:00.000Z',
      turns: 1,
      source: `/host/claude/projects/-work-shop/${CLAUDE_ID}.jsonl`,
      relativePath: `projects/-work-shop/${CLAUDE_ID}.jsonl`,
    };

    // Act
    const provenance = adoptedTranscriptProvenance('/fy/fleet/homes/r1', conversation, '2026-10-18T00:00:00.000Z');

    // Assert
    should(adoptedConversationFile('/fy/fleet/homes/r1', conversation)).equal(
      `/fy/fleet/homes/r1/projects/-work-shop/${CLAUDE_ID}.jsonl`,
    );
    should(provenance).deepEqual({
      v: 1,
      home: '/fy/fleet/homes/r1',
      harnessSessionId: CLAUDE_ID,
      identity: 'adopted',
      file: `/fy/fleet/homes/r1/projects/-work-shop/${CLAUDE_ID}.jsonl`,
      resolvedAt: '2026-10-18T00:00:00.000Z',
    });
  });
});

describe('a link that could not be made', () => {
  it('should say which disk problem it was', () => {
    // Act & Assert
    should(conversationLinkFailure('EXDEV')).deepEqual({
      kind: 'unavailable',
      reason: 'The conversation is on a different disk from Ferretry, so the runtime cannot share its file.',
    });
    should(conversationLinkFailure('EACCES').reason).equal(
      'The runtime could not reach the conversation file (EACCES).',
    );
    should(conversationLinkFailure(undefined).reason).match(/unknown error/u);
  });
});

describe('where a listing reads and what its rows say', () => {
  const POINTED = '44444444-4444-4444-8444-444444444444';
  const pointer = (path: string): string =>
    `Read the file ${path} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
  const reply = (text: string, at: string): string =>
    JSON.stringify({
      type: 'assistant',
      sessionId: POINTED,
      cwd: '/work/ferret',
      timestamp: at,
      message: { id: `m-${at}`, role: 'assistant', content: [{ type: 'text', text }] },
    });
  const said = (text: string, at: string): string => claude(text, at, { sessionId: POINTED, cwd: '/work/ferret' });
  const handoffTree: Tree = {
    ...tree,
    pool: {
      claude: {
        projects: {
          '-work-ferret': {
            [`${POINTED}.jsonl`]: [
              said(pointer('/fy/state/sessions/s-1/turns/turn-001.md'), '2026-10-18T08:00:00.000Z'),
              reply('Looking at the cart.', '2026-10-18T08:01:00.000Z'),
              said(pointer('/elsewhere/turns/turn-002.md'), '2026-10-18T08:02:00.000Z'),
              said(pointer('/fy/state/sessions/s-1/turns/turn-003.md'), '2026-10-18T08:03:00.000Z'),
              said('Ship it <system-reminder>be brief</system-reminder>', '2026-10-18T08:04:00.000Z'),
              reply('Shipped.', '2026-10-18T08:05:00.000Z'),
            ].join('\n'),
          },
        },
      },
    },
    fy: { state: { sessions: { 's-1': { turns: { 'turn-001.md': '# Assigned task\n\nFix the cart total\n' } } } } },
    elsewhere: { turns: { 'turn-002.md': 'Not read: outside every allowed folder' } },
  };
  const service = (files: FakeFiles) =>
    new ConversationImportService(files, ROOTS, parsers, { owners: async () => new Map() }, new RecordingAdopter(), {
      roots: ['/fy/state/sessions'],
      coordinatorHomes: [],
    });

  it('should list only Ferretry’s own history, or only the computer’s, when asked', async () => {
    // Arrange
    const subjectService = subject();

    // Act
    const ferretry = await subjectService.list({ source: 'ferretry' });
    const computer = await subjectService.list({ source: 'computer' });

    // Assert
    should(ferretry.conversations.map(row => row.id)).deepEqual([CLAUDE_ID]);
    should(computer.conversations.map(row => row.id)).deepEqual([CLAUDE_ID, CODEX_ID, CLAUDE_OLD]);
  });

  it('should read a pointer’s document inside the allowed folders only, and skip one it cannot read', async () => {
    // Arrange
    const files = new FakeFiles(handoffTree);

    // Act
    const listing = await service(files).list({ source: 'ferretry' });

    // Assert
    should(listing.conversations[0]).containDeep({
      id: POINTED,
      preview: 'Fix the cart total',
      latest: 'Ship it',
      turns: 2,
    });
    should(files.heads.map(read => read.file)).deepEqual([
      '/fy/state/sessions/s-1/turns/turn-001.md',
      '/fy/state/sessions/s-1/turns/turn-003.md',
    ]);
    should(files.heads.every(read => read.maxBytes === 64 * 1024)).be.true();
  });

  it('should preview the last exchanges of one conversation, cleaned the same way', async () => {
    // Arrange
    const subjectService = service(new FakeFiles(handoffTree));

    // Act
    const preview = await subjectService.preview('claude', POINTED);

    // Assert
    should(preview).deepEqual({
      id: POINTED,
      harness: 'claude',
      messages: [
        { role: 'user', text: 'Fix the cart total' },
        { role: 'assistant', text: 'Looking at the cart.' },
        { role: 'user', text: 'Ship it' },
        { role: 'assistant', text: 'Shipped.' },
      ],
    });
  });

  it('should preview nothing for a conversation no home holds or whose file is unreadable', async () => {
    // Arrange
    const unreadable: Tree = {
      pool: {
        claude: { projects: { '-work-ferret': { [`${POINTED}.jsonl`]: said('Hello', '2026-10-18T08:00:00Z') } } },
      },
    };
    const files = new FakeFiles(unreadable);
    const subjectService = service(files);
    await subjectService.list();
    files.text = async () => undefined;

    // Act & Assert
    should(await subjectService.preview('claude', 'missing')).be.undefined();
    should(await subjectService.preview('claude', POINTED)).be.undefined();
  });
});
