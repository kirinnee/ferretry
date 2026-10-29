/**
 * Describing one conversation file: the bounded read, the cache keyed on size and modification time, and
 * the preview — over a fake read-only file port and the real parsers. Every file is an invented fixture.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONVERSATION_HEAD_READ_MAX_BYTES,
  CONVERSATION_TAIL_READ_MAX_BYTES,
  type ConversationCandidate,
  type ConversationFiles,
  FileConversationDescriber,
} from '../../../src/lib/imports/conversation-describer.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import { PacedTranscriptParser, type TranscriptParsePacing } from '../../../src/lib/transcript/sliced.ts';

const UNPACED: TranscriptParsePacing = { now: () => 0, yieldToLoop: async () => undefined };
const parsers = {
  claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), UNPACED),
  codex: new PacedTranscriptParser(new CodexTranscriptParser(), UNPACED),
};

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '33333333-3333-4333-8333-333333333333';
const FILE = `/host/claude/projects/-work-shop/${CLAUDE_ID}.jsonl`;

const claude = (text: string, at: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'user',
    sessionId: CLAUDE_ID,
    cwd: '/work/shop',
    timestamp: at,
    message: { role: 'user', content: text },
    ...extra,
  });
const codexMeta = JSON.stringify({
  type: 'session_meta',
  timestamp: '2026-10-10T09:00:00.000Z',
  payload: { id: CODEX_ID, cwd: '/work/notes' },
});
const codexUser = (text: string): string =>
  JSON.stringify({
    type: 'response_item',
    timestamp: '2026-10-10T09:01:00.000Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });

const candidate = (extra: Partial<ConversationCandidate> = {}): ConversationCandidate => ({
  harness: 'claude',
  source: FILE,
  relativePath: `projects/-work-shop/${CLAUDE_ID}.jsonl`,
  nameId: CLAUDE_ID,
  ...extra,
});

/** Files by path; `sizes` overrides what `info` reports, so a big file need not be built. */
class FakeFiles implements ConversationFiles {
  readonly heads: { readonly file: string; readonly maxBytes: number }[] = [];
  readonly tails: { readonly file: string; readonly maxBytes: number }[] = [];
  mtime = 1;
  constructor(
    readonly texts: Record<string, string | undefined>,
    private readonly sizes: Readonly<Record<string, number>> = {},
  ) {}

  async entries(): Promise<readonly []> {
    return [];
  }

  async info(file: string) {
    const text = this.texts[file];
    return text === undefined && !(file in this.sizes)
      ? undefined
      : { modifiedAtMs: this.mtime, size: this.sizes[file] ?? text?.length ?? 0 };
  }

  async head(file: string, maxBytes: number): Promise<string | undefined> {
    this.heads.push({ file, maxBytes });
    return this.texts[file]?.slice(0, maxBytes);
  }

  async tail(file: string, maxBytes: number): Promise<string | undefined> {
    this.tails.push({ file, maxBytes });
    const text = this.texts[file];
    return text?.slice(Math.max(0, text.length - maxBytes));
  }
}

const transcript = [
  claude('Fix the cart total', '2026-10-17T08:00:00.000Z'),
  claude('Now ship it', '2026-10-17T08:01:00.000Z'),
].join('\n');

describe('FileConversationDescriber.describe', () => {
  test('describes a transcript and does not read it again while its size and time are unchanged', async () => {
    const files = new FakeFiles({ [FILE]: transcript });
    const describer = new FileConversationDescriber(files, parsers);

    const first = await describer.describe(candidate());
    const second = await describer.describe(candidate());

    expect(first).toMatchObject({ id: CLAUDE_ID, project: '/work/shop', preview: 'Fix the cart total', turns: 2 });
    expect(second).toBe(first);
    expect(files.heads).toHaveLength(1);
  });

  test('reads a file again once its modification time moves', async () => {
    const files = new FakeFiles({ [FILE]: transcript });
    const describer = new FileConversationDescriber(files, parsers);
    await describer.describe(candidate());

    files.mtime = 2;
    await describer.describe(candidate());

    expect(files.heads).toHaveLength(2);
  });

  test('describes nothing for a file that is gone, and remembers a file that said nothing', async () => {
    const files = new FakeFiles({ [FILE]: 'not a transcript\n' });
    const describer = new FileConversationDescriber(files, parsers);

    expect(await describer.describe(candidate({ source: '/host/missing.jsonl' }))).toBeUndefined();
    expect(await describer.describe(candidate())).toBeUndefined();
    expect(await describer.describe(candidate())).toBeUndefined();
    expect(files.heads).toHaveLength(1);
  });

  test('describes nothing when the file cannot be read after it was seen', async () => {
    const files = new FakeFiles({ [FILE]: undefined }, { [FILE]: 10 });

    expect(await new FileConversationDescriber(files, parsers).describe(candidate())).toBeUndefined();
  });

  test('describes a file larger than both ends together from its ends, as a floor on its turns', async () => {
    const middle = 'x'.repeat(10);
    const files = new FakeFiles(
      { [FILE]: `${transcript}\n${middle}\n` },
      { [FILE]: CONVERSATION_HEAD_READ_MAX_BYTES + CONVERSATION_TAIL_READ_MAX_BYTES + 1 },
    );

    const described = await new FileConversationDescriber(files, parsers).describe(candidate());

    expect(described).toMatchObject({ id: CLAUDE_ID, turnsAtLeast: true });
    expect(files.heads[0]?.maxBytes).toBe(CONVERSATION_HEAD_READ_MAX_BYTES);
    expect(files.tails[0]?.maxBytes).toBe(CONVERSATION_TAIL_READ_MAX_BYTES);
  });

  test('describes nothing when either end of a large file cannot be read', async () => {
    const files = new FakeFiles(
      { [FILE]: undefined },
      { [FILE]: CONVERSATION_HEAD_READ_MAX_BYTES + CONVERSATION_TAIL_READ_MAX_BYTES + 1 },
    );

    expect(await new FileConversationDescriber(files, parsers).describe(candidate())).toBeUndefined();
  });

  test('describes a large file whose tail has no complete record after its first line break', async () => {
    const files = new FakeFiles(
      { [FILE]: `${claude('Fix the cart total', '2026-10-17T08:00:00.000Z')}\npartial-without-break` },
      { [FILE]: CONVERSATION_HEAD_READ_MAX_BYTES + CONVERSATION_TAIL_READ_MAX_BYTES + 1 },
    );

    expect(await new FileConversationDescriber(files, parsers).describe(candidate())).toMatchObject({
      id: CLAUDE_ID,
    });
  });
});

describe('FileConversationDescriber.preview', () => {
  test('answers the last exchanges of a conversation under its own id', async () => {
    const files = new FakeFiles({ [FILE]: transcript });

    const preview = await new FileConversationDescriber(files, parsers).preview(candidate());

    expect(preview?.id).toBe(CLAUDE_ID);
    expect(preview?.harness).toBe('claude');
    expect(preview?.messages.map(message => message.text)).toEqual(['Fix the cart total', 'Now ship it']);
  });

  test("takes a Codex conversation's id from its own record, not from the file's name", async () => {
    const source = '/host/codex/sessions/2026/10/10/rollout-x.jsonl';
    const files = new FakeFiles({ [source]: [codexMeta, codexUser('Plan the offsite')].join('\n') });

    const preview = await new FileConversationDescriber(files, parsers).preview(
      candidate({ harness: 'codex', source, nameId: undefined }),
    );

    expect(preview).toMatchObject({ id: CODEX_ID, harness: 'codex' });
  });

  test('answers nothing for a file that is gone, unreadable, or not a conversation', async () => {
    const files = new FakeFiles({ [FILE]: undefined, '/host/plain.jsonl': 'nothing here\n' }, { [FILE]: 10 });
    const describer = new FileConversationDescriber(files, parsers);

    expect(await describer.preview(candidate({ source: '/host/missing.jsonl' }))).toBeUndefined();
    expect(await describer.preview(candidate())).toBeUndefined();
    expect(await describer.preview(candidate({ source: '/host/plain.jsonl' }))).toBeUndefined();
  });

  test('answers nothing for a conversation whose id is not a usable one', async () => {
    const files = new FakeFiles({ [FILE]: transcript });

    expect(
      await new FileConversationDescriber(files, parsers).preview(candidate({ nameId: '../etc' })),
    ).toBeUndefined();
    expect(
      await new FileConversationDescriber(files, parsers).preview(candidate({ nameId: undefined })),
    ).toBeUndefined();
  });

  test('reads a hand-off document only inside the scope it was given', async () => {
    const pointer = (path: string) =>
      `Read the file ${path} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
    const document = '/fy/state/sessions/s-1/turns/turn-001.md';
    const outside = '/elsewhere/turn-002.md';
    const files = new FakeFiles({
      [FILE]: [
        claude(pointer(document), '2026-10-17T08:00:00.000Z'),
        claude(pointer(outside), '2026-10-17T08:01:00.000Z'),
      ].join('\n'),
      [document]: '# Assigned task\n\nFix the cart total\n',
      [outside]: 'Not read',
    });

    const scoped = new FileConversationDescriber(files, parsers, {
      roots: ['/fy/state/sessions'],
      coordinatorHomes: [],
    });
    await scoped.preview(candidate());

    expect(files.heads.map(read => read.file).filter(file => !file.endsWith('.jsonl'))).toEqual([document]);
  });
});
