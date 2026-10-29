/**
 * Keeping existing conversations as ferrets: discovery over a fake, read-only file port and the real
 * parsers, the daemon-side search, and the adoption rules (duplicates, refusals, one at a time).
 *
 * Every file here is an invented fixture held in memory. No real CLI home is read.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { transcriptName } from '../../../src/lib/imports/conversation-name.ts';
import { NO_HANDOFF_SCOPE } from '../../../src/lib/imports/conversation-text.ts';
import {
  adoptedConversationFile,
  adoptedTranscriptProvenance,
  CONVERSATION_HEAD_READ_MAX_BYTES,
  CONVERSATION_TAIL_READ_MAX_BYTES,
  type ConversationAdopter,
  type ConversationAdoption,
  type ConversationFileEntry,
  type ConversationFiles,
  ConversationImportService,
  type ConversationListPolicy,
  type ConversationRoot,
  conversationHead,
  conversationKey,
  conversationLinkFailure,
  conversationResumeArguments,
  FileConversationDescriber,
} from '../../../src/lib/imports/index.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  PacedTranscriptParser,
  type TranscriptParsePacing,
} from '../../../src/lib/transcript/index.ts';

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

  /** A transcript read, counted apart from the hand-off documents `heads` records. */
  private transcript(file: string): string | undefined {
    this.reads += 1;
    const node = this.node(file);
    return typeof node === 'string' && !node.startsWith('UNREADABLE') ? node : undefined;
  }

  readonly heads: { readonly file: string; readonly maxBytes: number }[] = [];

  async head(file: string, maxBytes: number): Promise<string | undefined> {
    if (file.endsWith('.jsonl')) return this.transcript(file)?.slice(0, maxBytes);
    this.heads.push({ file, maxBytes });
    const node = this.node(file);
    return typeof node === 'string' ? node.slice(0, maxBytes) : undefined;
  }

  async tail(file: string, maxBytes: number): Promise<string | undefined> {
    if (file.endsWith('.jsonl') && !file.endsWith('session_index.jsonl')) {
      const text = this.transcript(file);
      return text?.slice(Math.max(0, text.length - maxBytes));
    }
    const node = this.node(file);
    return typeof node === 'string' ? node.slice(Math.max(0, node.length - maxBytes)) : undefined;
  }
}

const CODEX_NAMED = '44444444-4444-4444-8444-444444444444';

/** A clock that never advances, so a parse never yields and every test stays one deterministic step. */
const UNPACED: TranscriptParsePacing = { now: () => 0, yieldToLoop: async () => undefined };
const parsers = {
  claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), UNPACED),
  codex: new PacedTranscriptParser(new CodexTranscriptParser(), UNPACED),
};

/** The describer a service reads through: the real one, over the same fake files and parsers. */
const describing = (files: ConversationFiles, scope = NO_HANDOFF_SCOPE) =>
  new FileConversationDescriber(files, parsers, scope);

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
) => new ConversationImportService(files, ROOTS, describing(files), { owners: async () => owners }, adopter);

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
      keptIn: 'ferretry',
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
    const files = new FakeFiles(tree);
    const listing = await new ConversationImportService(
      files,
      [{ harness: 'claude', home: '/host/claude', source: 'computer' }],
      describing(files),
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
      keptIn: 'computer',
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

describe('conversation head', () => {
  it('should skip a line of the head that is not JSON and read the next one that is', () => {
    // Arrange — a transcript whose first record was cut off or scribbled over
    const text = `this is not json\n${claude('x', '2026-10-17T08:00:00.000Z')}`;

    // Act & Assert
    should(conversationHead('claude', text)).deepEqual({ project: '/work/shop', id: undefined });
    should(conversationHead('claude', 'still not json\n')).be.undefined();
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
    new ConversationImportService(
      files,
      ROOTS,
      describing(files, { roots: ['/fy/state/sessions'], coordinatorHomes: [] }),
      { owners: async () => new Map() },
      new RecordingAdopter(),
    );

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
    files.head = async () => undefined;
    const gone = new FakeFiles(unreadable);
    const goneService = service(gone);
    await goneService.list();
    const real = gone.info.bind(gone);
    let looks = 0;
    // Seen by the listing the preview runs, then gone by the time the preview reads it.
    gone.info = async file => (looks++ === 0 ? await real(file) : undefined);

    // Act & Assert
    should(await subjectService.preview('claude', 'missing')).be.undefined();
    should(await subjectService.preview('claude', POINTED)).be.undefined();
    // Listed, then gone before it was previewed.
    should(await goneService.preview('claude', POINTED)).be.undefined();
  });
});

describe('conversation names', () => {
  const claudeNamed = [
    claude('Fix the cart total', '2026-10-17T08:01:00.000Z'),
    JSON.stringify({ type: 'summary', summary: 'Cart total fix', leafUuid: 'u-1' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Repair cart  maths', sessionId: CLAUDE_ID }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Shop: cart bug', sessionId: CLAUDE_ID }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'A later generated title', sessionId: CLAUDE_ID }),
  ].join('\n');
  const namedTree: Tree = {
    host: {
      claude: { projects: { '-work-shop': { [`${CLAUDE_ID}.jsonl`]: claudeNamed } } },
      codex: {
        'session_index.jsonl': [
          JSON.stringify({ id: CODEX_ID, thread_name: 'Old release notes', updated_at: '2026-10-10T09:02:00Z' }),
          JSON.stringify({ id: CODEX_ID, thread_name: 'Release notes', updated_at: '2026-10-10T09:03:00Z' }),
          JSON.stringify({ id: CODEX_ID, thread_name: '   ' }),
          'not json',
        ].join('\n'),
        sessions: {
          '2026': {
            '10': {
              '10': {
                [`rollout-2026-10-10T09-00-00-${CODEX_ID}.jsonl`]: [
                  codexMeta,
                  codexUser('Draft the release notes', '2026-10-10T09:01:00.000Z'),
                ].join('\n'),
                [`rollout-2026-10-11T09-00-00-${CODEX_NAMED}.jsonl`]: [
                  JSON.stringify({
                    type: 'session_meta',
                    timestamp: '2026-10-11T09:00:00.000Z',
                    payload: { id: CODEX_NAMED, cwd: '/work/notes' },
                  }),
                  codexUser('Plan the offsite', '2026-10-11T09:01:00.000Z'),
                  JSON.stringify({
                    type: 'event_msg',
                    payload: { type: 'thread_name_updated', thread_id: CODEX_NAMED, thread_name: 'Offsite plan' },
                  }),
                  JSON.stringify({ type: 'event_msg', payload: { type: 'thread_name_updated', thread_name: 7 } }),
                  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
                  JSON.stringify({ type: 'event_msg', payload: 'text' }),
                ].join('\n'),
              },
            },
          },
        },
      },
    },
  };
  const codexSessions = (namedTree.host as { codex: { sessions: Tree } }).codex.sessions;
  const named = () => {
    const files = new FakeFiles(namedTree);
    return new ConversationImportService(
      files,
      [
        { harness: 'claude', home: '/host/claude', source: 'computer' },
        { harness: 'codex', home: '/host/codex', source: 'computer' },
      ],
      describing(files),
      { owners: async () => new Map() },
      new RecordingAdopter(),
    );
  };

  it('should name a Claude conversation by its /rename title over any generated one, the latest winning', async () => {
    // Act
    const listing = await named().list({ harness: 'claude' });

    // Assert
    should(listing.conversations[0]).containDeep({
      id: CLAUDE_ID,
      name: 'Shop: cart bug',
      preview: 'Fix the cart total',
    });
  });

  it('should fall back to the latest generated Claude title, a summary included', async () => {
    // Arrange
    const text = [
      claude('Hello', '2026-10-17T08:01:00.000Z'),
      JSON.stringify({ type: 'agent-name', agentName: '  ' }),
      JSON.stringify({ type: 'summary', summary: 'First summary' }),
      JSON.stringify({ type: 'summary', summary: 7 }),
    ].join('\n');

    // Act & Assert
    should(transcriptName('claude', text)).equal('First summary');
    should(
      transcriptName('claude', `${text}\n${JSON.stringify({ type: 'agent-name', agentName: 'Named by agent' })}`),
    ).equal('Named by agent');
    should(transcriptName('claude', claude('Hello', '2026-10-17T08:01:00.000Z'))).be.undefined();
    should(
      transcriptName('claude', JSON.stringify({ type: 'custom-title', customTitle: 'y'.repeat(200) })),
    ).have.length(120);
  });

  it('should name a Codex thread by the index first, then by the rename its rollout recorded', async () => {
    // Act
    const listing = await named().list({ harness: 'codex' });

    // Assert
    should(listing.conversations.map(row => [row.id, row.name])).deepEqual([
      [CODEX_NAMED, 'Offsite plan'],
      [CODEX_ID, 'Release notes'],
    ]);
  });

  it('should search the name, and treat a missing or unreadable Codex index as no names', async () => {
    // Arrange
    const service = named();
    const bareFiles = new FakeFiles({ host: { codex: { sessions: codexSessions } } });
    const bare = new ConversationImportService(
      bareFiles,
      [{ harness: 'codex', home: '/host/codex', source: 'computer' }],
      describing(bareFiles),
      { owners: async () => new Map() },
      new RecordingAdopter(),
    );

    // Act
    const byName = await service.list({ q: 'offsite' });
    const byIndexName = await service.list({ q: 'RELEASE' });
    const unnamed = await bare.list();

    // Assert
    should(byName.conversations.map(row => row.id)).deepEqual([CODEX_NAMED]);
    should(byIndexName.conversations.map(row => row.id)).deepEqual([CODEX_ID]);
    should(unnamed.conversations.map(row => row.name)).deepEqual(['Offsite plan', undefined]);
  });
});

/**
 * What a harness or Ferretry wrapped a conversation in never names it. Each fixture has the shape the CLI
 * writes: Ferretry's turn-file pointer line (and the title Claude Code generated FROM that line), Codex's
 * AGENTS.md and environment blocks as user messages, and Claude Code's slash-command wrappers.
 */
describe('conversations wrapped by a harness or by Ferretry', () => {
  const WRAPPED = '55555555-5555-4555-8555-555555555555';
  const CODEX_WRAPPED = '66666666-6666-4666-8666-666666666666';
  const TURN = '/fy/state/sessions/s-7/turns/turn-001.md';
  const pointer = (path: string): string =>
    `Read the file ${path} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
  const said = (text: string, at: string): string => claude(text, at, { sessionId: WRAPPED, cwd: '/work/ferret' });
  const titled = (aiTitle: string, extra: readonly string[] = []): string =>
    [
      said(pointer(TURN), '2026-10-19T08:00:00.000Z'),
      JSON.stringify({ type: 'ai-title', aiTitle, sessionId: WRAPPED }),
      ...extra,
    ].join('\n');
  const AGENTS_FILE = [
    '# AGENTS.md instructions for /work/api',
    '',
    '<INSTRUCTIONS>',
    '- Run your own shell/tool-call commands through `direnv exec . <command>`.',
    '- Never use Python for ad hoc scripting.',
    '</INSTRUCTIONS>',
  ].join('\n');
  const ENVIRONMENT = '<environment_context>\n  <cwd>/work/api</cwd>\n  <shell>zsh</shell>\n</environment_context>';
  const codexRollout = (...messages: readonly string[]): string =>
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-19T09:00:00.000Z',
        payload: { id: CODEX_WRAPPED, cwd: '/work/api' },
      }),
      ...messages.map((text, index) => codexUser(text, `2026-10-19T09:0${index + 1}:00.000Z`)),
    ].join('\n');
  const listed = async (claudeText: string | undefined, codexText?: string) => {
    const tree: Tree = {
      pool: {
        claude: { projects: { '-work-ferret': claudeText === undefined ? {} : { [`${WRAPPED}.jsonl`]: claudeText } } },
        codex: {
          sessions: {
            '2026': {
              '10': {
                '19':
                  codexText === undefined ? {} : { [`rollout-2026-10-19T09-00-00-${CODEX_WRAPPED}.jsonl`]: codexText },
              },
            },
          },
        },
      },
      fy: {
        state: {
          sessions: {
            's-7': { turns: { 'turn-001.md': '# Assigned task\n\nFix the checkout total when a coupon is applied\n' } },
          },
        },
      },
    };
    const files = new FakeFiles(tree);
    const service = new ConversationImportService(
      files,
      [
        { harness: 'claude', home: '/pool/claude', source: 'ferretry' },
        { harness: 'codex', home: '/pool/codex', source: 'ferretry' },
      ],
      describing(files, { roots: ['/fy/state/sessions'], coordinatorHomes: [] }),
      { owners: async () => new Map() },
      new RecordingAdopter(),
    );
    return (await service.list()).conversations;
  };

  it('should drop a title Claude Code generated from Ferretry’s turn pointer, and head the row by the real message', async () => {
    for (const title of [
      'Ferretry session turn-001 file',
      'Turn-001.md instructions',
      'Ferretry turn-001 instructions file',
    ]) {
      // Act
      const [row] = await listed(titled(title));

      // Assert
      should(row?.name).be.undefined();
      should(row?.preview).equal('Fix the checkout total when a coupon is applied');
    }
  });

  it('should keep a generated title about the conversation, and any name the owner chose', async () => {
    // Act
    const [generated] = await listed(titled('Checkout coupon total fix'));
    const [chosen] = await listed(
      titled('Turn-001.md instructions', [JSON.stringify({ type: 'custom-title', customTitle: 'Turn file cleanup' })]),
    );

    // Assert
    should(generated?.name).equal('Checkout coupon total fix');
    should(chosen?.name).equal('Turn file cleanup');
  });

  it('should keep a title that uses wrapper-like words when nothing wrapped the conversation', async () => {
    // Act
    const [row] = await listed(
      [
        said('Why does turn-001 of the instructions file fail?', '2026-10-19T08:00:00.000Z'),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Turn-001 instructions file failure', sessionId: WRAPPED }),
      ].join('\n'),
    );

    // Assert
    should(row?.name).equal('Turn-001 instructions file failure');
  });

  it('should never take Codex’s AGENTS.md or environment block for the first message', async () => {
    // Act
    const [separate] = await listed(
      undefined,
      codexRollout(AGENTS_FILE, ENVIRONMENT, 'Add retries to the invoice webhook'),
    );
    const [joined] = await listed(
      undefined,
      codexRollout(`${AGENTS_FILE}\n\n${ENVIRONMENT}\n\nAdd retries to the invoice webhook`),
    );

    // Assert
    should(separate).containDeep({ id: CODEX_WRAPPED, preview: 'Add retries to the invoice webhook', turns: 1 });
    should(separate?.latest).be.undefined();
    should(joined).containDeep({ id: CODEX_WRAPPED, preview: 'Add retries to the invoice webhook', turns: 1 });
  });

  it('should never take Claude Code’s slash-command wrappers for what the owner said', async () => {
    // Act
    const [row] = await listed(
      [
        said(
          '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.</local-command-caveat>',
          '2026-10-19T08:00:00.000Z',
        ),
        said(
          '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
          '2026-10-19T08:00:01.000Z',
        ),
        said('<local-command-stdout>Set model to Opus</local-command-stdout>', '2026-10-19T08:00:02.000Z'),
        said('Rename the product grid component', '2026-10-19T08:01:00.000Z'),
      ].join('\n'),
    );

    // Assert
    should(row).containDeep({ preview: 'Rename the product grid component', turns: 1 });
  });
});

describe('a conversation too large to read whole', () => {
  const ADOPTED = '55555555-5555-4555-8555-555555555555';
  const said = (text: string, at: string): string => claude(text, at, { sessionId: ADOPTED, cwd: '/work/adopted' });
  /** Owner messages nobody reads: the middle of a 9 MB transcript. */
  const middle = Array.from({ length: 900 }, (_, index) =>
    said(`middle ${String(index)} ${'x'.repeat(10_000)}`, '2026-10-19T08:00:00.000Z'),
  );
  const transcript = [
    said('Start the migration', '2026-10-01T08:00:00.000Z'),
    ...middle,
    said('hi', '2026-10-20T15:00:00.000Z'),
    claudeReply('2026-10-20T15:00:05.000Z'),
  ].join('\n');
  const big: Tree = { pool: { claude: { projects: { '-work-adopted': { [`${ADOPTED}.jsonl`]: transcript } } } } };

  it('should describe it from its two ends, and say its turn count is only a floor', async () => {
    // Arrange
    const files = new FakeFiles(big);
    const reads: number[] = [];
    const head = files.head.bind(files);
    const tail = files.tail.bind(files);
    files.head = async (file, maxBytes) => {
      reads.push(maxBytes);
      return await head(file, maxBytes);
    };
    files.tail = async (file, maxBytes) => {
      reads.push(maxBytes);
      return await tail(file, maxBytes);
    };

    // Act
    const listing = await subject(new Map(), new RecordingAdopter(), files).list({ source: 'ferretry' });
    const preview = await subject(new Map(), new RecordingAdopter(), files).preview('claude', ADOPTED);

    // Assert
    const row = listing.conversations[0];
    should(transcript.length).be.above(CONVERSATION_HEAD_READ_MAX_BYTES + CONVERSATION_TAIL_READ_MAX_BYTES);
    should(row).containDeep({
      id: ADOPTED,
      project: '/work/adopted',
      preview: 'Start the migration',
      latest: 'hi',
      lastActivityAt: '2026-10-20T15:00:05.000Z',
      model: 'claude-sonnet-4-5',
      turnsAtLeast: true,
    });
    should(row?.turns).be.below(900);
    should(reads.every(bytes => bytes <= CONVERSATION_HEAD_READ_MAX_BYTES)).be.true();
    should(preview?.messages.at(-1)?.text).equal('Done.');
  });

  it('should drop the pieces of records each end cuts through, even an end with no record boundary', async () => {
    // Arrange: a tail that is one enormous unfinished record, which no part of may be parsed.
    const files = new FakeFiles({
      pool: {
        claude: {
          projects: { '-work-adopted': { [`${ADOPTED}.jsonl`]: `${transcript}\n${'y'.repeat(5 * 1024 * 1024)}` } },
        },
      },
    });

    // Act
    const listing = await subject(new Map(), new RecordingAdopter(), files).list({ source: 'ferretry' });

    // Assert
    should(listing.conversations[0]).containDeep({ preview: 'Start the migration', turnsAtLeast: true });
    // What the head did read is all it can say; nothing of the unfinished record is a message.
    should(listing.conversations[0]?.latest).startWith('middle ');
    should(JSON.stringify(listing)).not.containEql('yyyy');
  });

  it('should read a small conversation whole and claim an exact count', async () => {
    // Arrange
    const files = new FakeFiles({
      pool: {
        claude: {
          projects: {
            '-work-adopted': {
              [`${ADOPTED}.jsonl`]: [said('a', '2026-10-01T08:00:00.000Z'), said('b', '2026-10-01T08:01:00.000Z')].join(
                '\n',
              ),
            },
          },
        },
      },
    });

    // Act
    const listing = await subject(new Map(), new RecordingAdopter(), files).list({ source: 'ferretry' });

    // Assert
    should(listing.conversations[0]).containDeep({ turns: 2 });
    should(listing.conversations[0]?.turnsAtLeast).be.undefined();
  });
});

describe('keeping in sync with the computer’s own history', () => {
  const newer = '55555555-5555-4555-8555-555555555555';
  const policy = (listed: () => boolean): ConversationListPolicy & { asked: number } => {
    const state = {
      asked: 0,
      listsComputer: async () => {
        state.asked += 1;
        return listed();
      },
    };
    return state;
  };
  const synced = (files: FakeFiles, setting: ConversationListPolicy, adopter = new RecordingAdopter()) =>
    new ConversationImportService(files, ROOTS, describing(files), { owners: async () => new Map() }, adopter, setting);

  it('should list Ferretry’s history and the computer’s together, saying where each file is kept', async () => {
    // Arrange
    const subjectService = synced(
      new FakeFiles(tree),
      policy(() => true),
    );

    // Act
    const actual = await subjectService.list({ source: 'synced' });

    // Assert
    const expected = [
      [CLAUDE_ID, 'ferretry'],
      [CODEX_ID, 'computer'],
      [CLAUDE_OLD, 'computer'],
    ];
    should(actual.conversations.map(row => [row.id, row.keptIn])).deepEqual(expected);
    should(actual.computerListed).equal(undefined);
  });

  it('should list the computer’s history when no switch was ever given', async () => {
    // Arrange
    const subjectService = subject();

    // Act
    const actual = await subjectService.list({ source: 'synced' });

    // Assert
    should(actual.conversations.map(row => row.id)).deepEqual([CLAUDE_ID, CODEX_ID, CLAUDE_OLD]);
  });

  it('should keep one conversation held in both places as Ferretry’s, so an adopted one is listed once', async () => {
    // Arrange
    const subjectService = synced(
      new FakeFiles(tree),
      policy(() => true),
    );

    // Act
    const actual = await subjectService.list({ source: 'synced', harness: 'claude', q: 'cart' });

    // Assert
    should(actual.conversations.map(row => [row.id, row.keptIn])).deepEqual([[CLAUDE_ID, 'ferretry']]);
  });

  it('should list only Ferretry’s history, and say so, while listing the computer is off', async () => {
    // Arrange
    const setting = policy(() => false);
    const subjectService = synced(new FakeFiles(tree), setting);

    // Act
    const actual = await subjectService.list({ source: 'synced' });

    // Assert
    should(actual.conversations.map(row => row.id)).deepEqual([CLAUDE_ID]);
    should(actual.computerListed).equal(false);
  });

  it('should still read the computer’s history when asked for it by name, or for both without a source', async () => {
    // Arrange
    const setting = policy(() => false);
    const subjectService = synced(new FakeFiles(tree), setting);

    // Act
    const computer = await subjectService.list({ source: 'computer' });
    const both = await subjectService.list();

    // Assert
    should(computer.conversations.map(row => row.id)).deepEqual([CLAUDE_ID, CODEX_ID, CLAUDE_OLD]);
    should(both.conversations.map(row => row.id)).deepEqual([CLAUDE_ID, CODEX_ID, CLAUDE_OLD]);
    should(computer.computerListed).equal(undefined);
    // Only a synced listing consults the switch.
    should(setting.asked).equal(0);
  });

  it('should adopt a computer conversation on the spot even while listing the computer is off', async () => {
    // Arrange
    const adopter = new RecordingAdopter();
    const subjectService = synced(
      new FakeFiles(tree),
      policy(() => false),
      adopter,
    );

    // Act
    const actual = await subjectService.adopt({
      harness: 'codex',
      runtime: 'codex-main',
      conversations: [{ id: CODEX_ID, start: true }],
    });

    // Assert
    should(actual.adopted.map(item => item.id)).deepEqual([CODEX_ID]);
    should(adopter.calls.map(call => [call.conversation.source, call.conversation.keptIn, call.start])).deepEqual([
      [`/host/codex/sessions/2026/10/10/rollout-2026-10-10T09-00-00-${CODEX_ID}.jsonl`, 'computer', true],
    ]);
  });

  it('should see a new conversation, and the switch flipping, on the very next listing with nothing timed', async () => {
    // Arrange
    let listed = false;
    const mutable: Record<string, Tree | string | null> = {
      host: { claude: { projects: {} } },
      pool: { claude: { projects: {} } },
    };
    const subjectService = synced(
      new FakeFiles(mutable),
      policy(() => listed),
    );
    const first = await subjectService.list({ source: 'synced' });

    // Act
    mutable.host = {
      claude: {
        projects: {
          '-work-shop': { [`${newer}.jsonl`]: claude('Brand new', '2026-10-20T08:00:00.000Z', { sessionId: newer }) },
        },
      },
    };
    const hidden = await subjectService.list({ source: 'synced' });
    listed = true;
    const shown = await subjectService.list({ source: 'synced' });

    // Assert
    should(first.conversations).deepEqual([]);
    should(hidden.conversations).deepEqual([]);
    should(hidden.computerListed).equal(false);
    should(shown.conversations.map(row => [row.id, row.keptIn])).deepEqual([[newer, 'computer']]);
  });
});
