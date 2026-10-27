import { describe, it } from 'bun:test';
import should from 'should';
import { boundHistory, entryTokens, historyBudget, turnsOf } from '../../../src/lib/transcript/convert/bound.ts';
import { type ConversationEntry, oneLine, truncated } from '../../../src/lib/transcript/convert/conversation.ts';
import {
  CONVERSION_NOTICE_HEAD,
  type ConversionRequest,
  type Converted,
  convertConversation,
} from '../../../src/lib/transcript/convert/convert.ts';
import { readClaudeConversation } from '../../../src/lib/transcript/convert/read-claude.ts';
import { readCodexConversation } from '../../../src/lib/transcript/convert/read-codex.ts';
import { derivedUuid, exitCodeOf, toolLine } from '../../../src/lib/transcript/convert/render.ts';
import { pairTools, parseDataUrl, toolInputLine } from '../../../src/lib/transcript/convert/tool-pairing.ts';
import { handoffPointerPaths, userText } from '../../../src/lib/transcript/convert/user-text.ts';
import { harnessVersionRefusal, parseHarnessVersion } from '../../../src/lib/transcript/convert/versions.ts';
import { writeClaudeTranscript } from '../../../src/lib/transcript/convert/write-claude.ts';
import { codexRolloutRelativePath, writeCodexRollout } from '../../../src/lib/transcript/convert/write-codex.ts';

/**
 * The converter, measured on transcripts real CLIs wrote (`scripts/local/record-conversion-fixtures.ts`):
 * Claude Code 2.1.281 and 2.1.304, Codex 0.145.0, 0.156.1, 0.163.0 and 0.164.0. Each is converted and read back
 * with the OTHER side's reader, so a round trip proves both the writer and the reader of each format.
 */

const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(`../../fixtures/transcript/convert/${name}`, import.meta.url)).text();

/** A Claude fixture up to (not including) its compaction, so the whole scripted conversation is live. */
const beforeCompaction = (text: string): string => {
  const lines = text.split('\n');
  return lines
    .slice(
      0,
      lines.findIndex(line => line.includes('"compact_boundary"')),
    )
    .join('\n');
};

const NO_DOCUMENTS = new Map<string, string>();
const AT = '2026-10-20T08:00:00.000Z';
const TARGET_ID = '11111111-2222-4333-8444-555555555555';

const request = (
  source: ConversionRequest['source'],
  target: Partial<ConversionRequest['target']> & Pick<ConversionRequest['target'], 'harness'>,
): ConversionRequest => ({
  source,
  target: {
    version: target.harness === 'claude' ? '2.1.304 (Claude Code)' : 'codex-cli 0.163.0',
    conversationId: TARGET_ID,
    cwd: '/work/repo',
    contextWindow: 200_000,
    ...target,
  },
  attachmentDirectory: '/state/s1/conversions/x',
  at: AT,
});

const converted = (result: ReturnType<typeof convertConversation>): Converted => {
  if (result.kind !== 'converted') throw new Error(`refused: ${result.reason}`);
  return result;
};

/** The text a message entry says, for comparing two readings of one conversation. */
const said = (entries: readonly ConversationEntry[]): readonly string[] =>
  entries.map(entry =>
    entry.kind === 'shell'
      ? `$ ${entry.command} → ${entry.output.trim()}`
      : `${entry.kind}: ${'text' in entry ? entry.text : entry.name}`,
  );

const claudeLine = (record: Record<string, unknown>): string =>
  JSON.stringify({ isSidechain: false, sessionId: 'src-1', version: '2.1.281', timestamp: AT, ...record });
const codexLine = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: AT, type, payload });
const codexMeta = codexLine('session_meta', { id: 'thread-1', cli_version: '0.156.1' });

describe('cross-harness conversion — real Claude transcripts onto Codex', () => {
  for (const version of ['2.1.281', '2.1.304']) {
    it(`should carry Claude Code ${version}'s whole conversation into a rollout Codex reads back in order`, async () => {
      // Arrange
      const text = beforeCompaction(await fixture(`claude-${version}.jsonl`));
      const source = readClaudeConversation(text, NO_DOCUMENTS);

      // Act
      const result = converted(
        convertConversation(request({ harness: 'claude', text, documents: NO_DOCUMENTS }, { harness: 'codex' })),
      );
      const back = readCodexConversation(result.transcript, NO_DOCUMENTS);

      // Assert
      should(source.version).equal(version);
      should(back.version).equal('0.163.0');
      should(back.conversationId).equal(TARGET_ID);
      const shells = back.entries.filter(entry => entry.kind === 'shell');
      should(shells).deepEqual([
        { kind: 'shell', command: 'echo fixture-output', output: 'fixture-output', failed: false, at: shells[0]?.at },
      ]);
      const texts = said(back.entries).join('\n');
      for (const words of [
        'RUNTOOL show me a marker',
        '[ran Read: notes.txt]',
        '[ran Agent: Look around]',
        'IMAGE what is in this picture?',
        '[image attached — saved at /state/s1/conversions/x/attachment-1.png]',
        'Thought about it.',
      ])
        should(texts).containEql(words);
      should(texts).not.containEql('Private reasoning');
      should(result.summary).match({
        converter: 1,
        source: { harness: 'claude', version },
        target: { harness: 'codex', version: '0.163.0', conversationId: TARGET_ID },
        omittedTurns: 0,
        nativeToolCalls: 1,
        toolCallsAsText: 2,
        attachments: 1,
        dropped: { reasoning: 1, compactions: 0 },
      });
      should(result.files).have.length(1);
      should(result.files[0]?.name).equal('attachment-1.png');
      should(result.nativeTools).deepEqual(['exec_command']);
      should(result.sentinels[0]).startWith(CONVERSION_NOTICE_HEAD);
    });
  }

  it('should resume from the newest compaction, as Claude itself would, carrying its summary', async () => {
    // Arrange
    const text = await fixture('claude-2.1.304.jsonl');

    // Act
    const read = readClaudeConversation(text, NO_DOCUMENTS);

    // Assert
    should(read.dropped.compactions).equal(1);
    should(read.dropped.reasoning).equal(0);
    should(read.entries.map(entry => entry.kind)).deepEqual(['user', 'user', 'assistant']);
    should((read.entries[0] as { text: string }).text).startWith('[Summary of the earlier conversation]\n');
    should((read.entries[1] as { text: string }).text).equal('After the compaction, anything else?');
  });
});

describe('cross-harness conversion — real Codex rollouts onto Claude', () => {
  for (const version of ['0.145.0', '0.156.1', '0.163.0', '0.164.0']) {
    it(`should carry Codex ${version}'s whole conversation into a transcript Claude reads back in order`, async () => {
      // Arrange
      const text = await fixture(`codex-${version}.jsonl`);
      const source = readCodexConversation(text, NO_DOCUMENTS);

      // Act
      const result = converted(
        convertConversation(
          request({ harness: 'codex', text, documents: NO_DOCUMENTS }, { harness: 'claude', model: 'claude-opus-5-5' }),
        ),
      );
      const back = readClaudeConversation(result.transcript, NO_DOCUMENTS);

      // Assert
      should(source.version).equal(version);
      should(back.version).equal('2.1.304');
      should(back.model).equal('claude-opus-5-5');
      should(
        back.entries.filter(entry => entry.kind === 'shell').map(entry => (entry as { command: string }).command),
      ).deepEqual(['echo fixture-output']);
      const texts = said(back.entries).join('\n');
      for (const words of [
        'RUNTOOL show me a marker',
        '[ran update_plan:',
        'IMAGE what is in this picture?',
        'Thought about it.',
      ])
        should(texts).containEql(words);
      should(result.summary.dropped.reasoning).equal(1);
      should(result.nativeTools).deepEqual(['Bash']);
      // Every record of a Claude transcript is one link of a single chain.
      const records = result.transcript
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { uuid: string; parentUuid: string | null });
      for (const [index, record] of records.entries())
        should(record.parentUuid).equal(index === 0 ? null : records[index - 1]?.uuid);
    });
  }
});

describe('cross-harness conversion — refusals', () => {
  const claude = claudeLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } });

  it('should refuse to convert onto the harness the conversation is already in', () => {
    // Arrange + Act
    const result = convertConversation(
      request({ harness: 'claude', text: claude, documents: NO_DOCUMENTS }, { harness: 'claude' }),
    );

    // Assert
    should(result).deepEqual({
      kind: 'refused',
      reason: "This conversation is already Claude Code's; it needs no conversion to resume there.",
    });
  });

  it('should refuse a source written by an untested version, or one that names none', () => {
    // Arrange
    const newer = claude.replace('2.1.281', '2.2.0');
    const unversioned = claude.replace(',"version":"2.1.281"', '');

    // Act
    const results = [newer, unversioned].map(text =>
      convertConversation(request({ harness: 'claude', text, documents: NO_DOCUMENTS }, { harness: 'codex' })),
    );

    // Assert
    should(results).deepEqual([
      {
        kind: 'refused',
        reason:
          "This conversation was written by Claude Code 2.2.0, and the converter is tested only on Claude Code 2.1.2xx, 2.1.3xx, so it can't be converted safely.",
      },
      {
        kind: 'refused',
        reason:
          "This conversation doesn't record which Claude Code version wrote it, and the converter is tested only on Claude Code 2.1.2xx, 2.1.3xx, so it can't be converted safely.",
      },
    ]);
  });

  it('should refuse a target CLI of an untested or unknown version', () => {
    // Arrange + Act
    const untested = convertConversation(
      request(
        { harness: 'claude', text: claude, documents: NO_DOCUMENTS },
        { harness: 'codex', version: 'codex-cli 0.150.2' },
      ),
    );
    const unknown = convertConversation(
      request({ harness: 'claude', text: claude, documents: NO_DOCUMENTS }, { harness: 'codex', version: undefined }),
    );

    // Assert
    should(untested).deepEqual({
      kind: 'refused',
      reason:
        "This machine runs Codex 0.150.2, and the converter is tested only on Codex 0.145, 0.156, 0.163, 0.164, so Ferretry won't write a conversation it hasn't seen that version accept.",
    });
    should(unknown).deepEqual({
      kind: 'refused',
      reason:
        "Ferretry couldn't tell which Codex version this machine runs, and the converter is tested only on Codex 0.145, 0.156, 0.163, 0.164, so it won't write a conversation for it.",
    });
  });

  it('should refuse a conversation with nothing to carry, and a window with no room for any of it', () => {
    // Arrange
    const empty = claudeLine({ type: 'user', uuid: 'u1', isMeta: true, message: { role: 'user', content: 'meta' } });

    // Act
    const nothing = convertConversation(
      request({ harness: 'claude', text: empty, documents: NO_DOCUMENTS }, { harness: 'codex' }),
    );
    const noRoom = convertConversation(
      request({ harness: 'claude', text: claude, documents: NO_DOCUMENTS }, { harness: 'codex', contextWindow: 0 }),
    );

    // Assert
    should(nothing).deepEqual({
      kind: 'refused',
      reason: "There's nothing in this Claude Code conversation that can be carried over yet.",
    });
    should(noRoom).deepEqual({
      kind: 'refused',
      reason: "The target model's 0-token window leaves no room for any of this conversation.",
    });
  });
});

describe('cross-harness conversion — size bounding', () => {
  /** A long conversation: `turns` exchanges, each a question, a long answer and a shell command. */
  const long = (turns: number): string =>
    Array.from({ length: turns }, (_, index) =>
      [
        claudeLine({ type: 'user', uuid: `u${index}`, message: { role: 'user', content: `question ${index}` } }),
        claudeLine({
          type: 'assistant',
          uuid: `a${index}`,
          message: {
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [
              { type: 'text', text: `answer ${index} ${'x'.repeat(3000)}` },
              { type: 'tool_use', id: `t${index}`, name: 'Bash', input: { command: `echo ${index}` } },
            ],
          },
        }),
        claudeLine({
          type: 'user',
          uuid: `r${index}`,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${index}`, content: `${index}` }] },
        }),
      ].join('\n'),
    ).join('\n');

  it('should keep the newest whole turns that fit and tell the target how many were left out', () => {
    // Arrange
    const text = long(300);

    // Act
    const result = converted(
      convertConversation(
        request({ harness: 'claude', text, documents: NO_DOCUMENTS }, { harness: 'codex', contextWindow: 20_000 }),
      ),
    );
    const back = readCodexConversation(result.transcript, NO_DOCUMENTS);

    // Assert
    should(result.summary.turns).equal(300);
    should(result.summary.keptTurns).be.above(0).and.below(20);
    should(result.summary.omittedTurns).equal(300 - result.summary.keptTurns);
    should(result.summary.estimatedTokens).be.belowOrEqual(historyBudget(20_000));
    const opening = (back.entries[0] as { text: string }).text;
    should(opening).containEql(`[earlier history omitted: ${result.summary.omittedTurns} turns]`);
    should(opening).endWith(`question ${300 - result.summary.keptTurns}`);
    should(said(back.entries).at(-1)).equal('shell: $ echo 299 → 299'.replace('shell: ', ''));
  });

  it('should cut the newest turn itself when it alone is bigger than the window allows', () => {
    // Arrange
    const huge = [
      claudeLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: `start ${'q'.repeat(9000)}` } }),
      claudeLine({
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(9000) }] },
      }),
      claudeLine({
        type: 'assistant',
        uuid: 'a2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'last words' }] },
      }),
    ].join('\n');

    // Act
    const result = converted(
      convertConversation(
        request({ harness: 'claude', text: huge, documents: NO_DOCUMENTS }, { harness: 'codex', contextWindow: 4000 }),
      ),
    );
    const back = readCodexConversation(result.transcript, NO_DOCUMENTS);

    // Assert
    should(result.summary).match({ turns: 1, keptTurns: 1, omittedTurns: 0, cutNewest: true });
    should((back.entries[0] as { text: string }).text).containEql('… [message truncated to fit]');
    should(said(back.entries)).deepEqual([said(back.entries)[0], 'assistant: last words']);
  });

  it('should group entries into turns at each thing the person said, and count a leading agent turn', () => {
    // Arrange
    const entries: ConversationEntry[] = [
      { kind: 'assistant', text: 'carried on from a summary' },
      { kind: 'user', text: 'one', attachments: [] },
      { kind: 'tool', name: 'Read', input: 'a', failed: false },
      { kind: 'user', text: 'two', attachments: [{ kind: 'image', data: 'AA' }] },
    ];

    // Act
    const turns = turnsOf(entries);
    const nothing = boundHistory([], 100);
    const tooSmall = boundHistory([{ kind: 'user', text: 'x'.repeat(100), attachments: [] }], 1);

    // Assert
    should(turns.map(turn => turn.length)).deepEqual([1, 2, 1]);
    should(entryTokens(entries[3] as ConversationEntry)).equal(41);
    should(entryTokens({ kind: 'shell', command: 'ls', output: 'a', failed: false })).equal(15);
    should(nothing).match({ entries: [], turns: 0, keptTurns: 0, omittedTurns: 0, cutNewest: false });
    should(tooSmall).match({ entries: [], keptTurns: 0, omittedTurns: 1, cutNewest: true });
    should(historyBudget(-5)).equal(0);
  });

  it('should keep a cut turn that opens with the agent rather than shorten what the agent said', () => {
    // Arrange
    const entries: ConversationEntry[] = [
      { kind: 'assistant', text: 'z'.repeat(600) },
      { kind: 'assistant', text: 'newest' },
    ];

    // Act
    const cut = boundHistory(entries, 150);

    // Assert
    should(cut.entries).deepEqual([entries[1]]);
    should(cut.cutNewest).be.true();
  });
});

describe('cross-harness conversion — attachments and hand-off documents', () => {
  it('should save an embedded attachment, reference a linked one, and say when one could not be carried', () => {
    // Arrange
    const text = claudeLine({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'see these' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
          { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
          {
            type: 'document',
            title: 'Spec v2.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' },
          },
          { type: 'document', source: { type: 'text' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/x-odd', data: 'CCCC' } },
        ],
      },
    });

    // Act
    const result = converted(
      convertConversation(request({ harness: 'claude', text, documents: NO_DOCUMENTS }, { harness: 'codex' })),
    );
    const opening = (readCodexConversation(result.transcript, NO_DOCUMENTS).entries[0] as { text: string }).text;

    // Assert
    should(result.files).deepEqual([
      { name: 'attachment-1.jpg', data: 'AAAA' },
      { name: 'attachment-3-Spec_v2.pdf', data: 'BBBB' },
      { name: 'attachment-5.bin', data: 'CCCC' },
    ]);
    should(opening).endWith(
      [
        'see these',
        '[image attached — saved at /state/s1/conversions/x/attachment-1.jpg]',
        '[image attached: https://example.test/a.png]',
        '[document Spec v2.pdf attached — saved at /state/s1/conversions/x/attachment-3-Spec_v2.pdf]',
        '[document attached — not carried]',
        '[image attached — saved at /state/s1/conversions/x/attachment-5.bin]',
      ].join('\n'),
    );
    should(result.summary.attachments).equal(5);
  });

  it("should replace Ferretry's pointer with the document it names, and keep a pointer it could not read", () => {
    // Arrange
    const turn = '/state/s1/turns/turn-002.md';
    const queued = '/state/s1/channel/queued-abc.md';
    const unread = '/state/s1/turns/turn-003.md';
    const pointer = (path: string) =>
      `Read the file ${path} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
    const queuedPointer = `Read the queued message file at ${queued} completely now, then follow every instruction inside it.`;
    const documents = new Map([
      [
        turn,
        'contract\n# Assigned task\n\nFix the login bug.\n\nAttached files — open them from these paths:\n- /state/s1/a.png (image/png)\n',
      ],
      [queued, 'Also update the docs.\n'],
    ]);
    const text = [pointer(turn), queuedPointer, pointer(unread)]
      .map((content, index) => claudeLine({ type: 'user', uuid: `u${index}`, message: { role: 'user', content } }))
      .join('\n');

    // Act
    const read = readClaudeConversation(text, documents);

    // Assert
    should(handoffPointerPaths(text)).deepEqual([turn, queued, unread]);
    should(read.entries.map(entry => (entry as { text: string }).text)).deepEqual([
      'Fix the login bug.\n\nAttached files — open them from these paths:\n- /state/s1/a.png (image/png)',
      'Also update the docs.',
      pointer(unread),
    ]);
  });

  it("should strip the harness's own blocks and drop a message that was nothing else", () => {
    // Arrange + Act + Assert
    should(userText('<system-reminder>x</system-reminder>\nreal words', NO_DOCUMENTS)).equal('real words');
    should(userText('<environment_context><cwd>/a</cwd></environment_context>', NO_DOCUMENTS)).be.undefined();
    should(userText('[Request interrupted by user]', NO_DOCUMENTS)).be.undefined();
  });
});

describe('cross-harness conversion — reading Claude Code records', () => {
  it('should drop sidechains, meta records, synthetic errors, reasoning and reminders, and count them', () => {
    // Arrange
    const text = [
      claudeLine({ type: 'user', uuid: 'side', isSidechain: true, message: { role: 'user', content: 'subagent' } }),
      claudeLine({ type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'meta' } }),
      claudeLine({ type: 'attachment', uuid: 'att', attachment: { type: 'environment' } }),
      claudeLine({
        type: 'attachment',
        uuid: 'queued',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: 'typed while busy',
          origin: { kind: 'human' },
        },
      }),
      claudeLine({
        type: 'user',
        uuid: 'empty',
        message: { role: 'user', content: '<command-name>/clear</command-name>' },
      }),
      claudeLine({ type: 'user', uuid: 'none', message: { role: 'user', content: [] } }),
      claudeLine({
        type: 'user',
        uuid: 'odd',
        message: { role: 'user', content: [null, 'plain string block', { type: 'mystery' }] },
      }),
      claudeLine({
        type: 'assistant',
        uuid: 'syn',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
      }),
      claudeLine({
        type: 'assistant',
        uuid: 'err',
        isApiErrorMessage: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'oops' }] },
      }),
      claudeLine({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            null,
            { type: 'redacted_thinking', data: 'x' },
            { type: 'text', text: '   ' },
            { type: 'text', text: 'searching' },
            { type: 'server_tool_use', id: 'ws1', name: 'web_search', input: { query: 'bun docs' } },
            { type: 'web_search_tool_result', tool_use_id: 'ws1', content: [] },
            { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'false' } },
            { type: 'tool_use', id: 'g1', input: 'raw' },
          ],
        },
      }),
      claudeLine({
        type: 'user',
        uuid: 'r1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b1',
              content: [{ type: 'text', text: 'Exit code 1' }, { type: 'image' }, { type: 'other' }],
              is_error: true,
            },
            { type: 'tool_result', tool_use_id: 'gone', content: 'orphan' },
            { type: 'tool_result', content: { odd: true } },
          ],
        },
      }),
      claudeLine({ type: 'system', subtype: 'informational' }),
      claudeLine({ type: 'summary', summary: 'title' }),
      'not json at all',
      '[1,2]',
    ].join('\n');

    // Act
    const read = readClaudeConversation(text, NO_DOCUMENTS);

    // Assert
    should(read.dropped).deepEqual({ reasoning: 1, sidechains: 1, internal: 7, compactions: 0 });
    should(read.entries).deepEqual([
      { kind: 'user', text: 'typed while busy', attachments: [], at: AT },
      { kind: 'user', text: 'plain string block', attachments: [], at: AT },
      { kind: 'assistant', text: 'searching', at: AT },
      { kind: 'tool', name: 'web_search', input: 'bun docs', output: '[web search results]', failed: false, at: AT },
      { kind: 'shell', command: 'false', output: 'Exit code 1\n[image]', failed: true, at: AT },
      { kind: 'tool', name: 'tool', input: 'raw', failed: false, at: AT },
    ]);
  });

  it('should keep a Claude failure exit code through Codex and back', () => {
    // Arrange
    const text = [
      claudeLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'run it' } }),
      claudeLine({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'exit 3' } }],
        },
      }),
      claudeLine({
        type: 'user',
        uuid: 'r1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'Exit code 3\nboom', is_error: true }],
        },
      }),
      claudeLine({
        type: 'assistant',
        uuid: 'a2',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'false' } }],
        },
      }),
      claudeLine({
        type: 'user',
        uuid: 'r2',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'b2', content: 'nope', is_error: true }],
        },
      }),
    ].join('\n');

    // Act
    const result = converted(
      convertConversation(request({ harness: 'claude', text, documents: NO_DOCUMENTS }, { harness: 'codex' })),
    );
    const back = readCodexConversation(result.transcript, NO_DOCUMENTS);

    // Assert
    should(back.entries.slice(1)).deepEqual([
      { kind: 'shell', command: 'exit 3', output: 'Exit code 3\nboom', failed: true, at: AT },
      { kind: 'shell', command: 'false', output: 'Exit code 1\nnope', failed: true, at: AT },
    ]);
  });
});

describe('cross-harness conversion — reading Codex records', () => {
  it('should read every Codex tool shape, keep only paired shell commands native, and drop the rest it cannot carry', () => {
    // Arrange
    const call = (type: string, payload: Record<string, unknown>) => codexLine('response_item', { type, ...payload });
    const text = [
      codexMeta,
      codexLine('turn_context', { model: 'gpt-5.5' }),
      codexLine('turn_context', {}),
      call('message', { role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }),
      call('message', {
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }],
      }),
      call('message', {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://example.test/i.png' },
          { type: 'input_image' },
          null,
        ],
      }),
      call('message', { role: 'assistant', content: [{ type: 'output_text', text: '' }] }),
      call('message', { role: 'assistant' }),
      call('reasoning', { encrypted_content: 'x' }),
      call('function_call', {
        name: 'shell',
        call_id: 'c1',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'], workdir: '/w' }),
      }),
      call('function_call_output', {
        call_id: 'c1',
        output: JSON.stringify({ output: 'a b', metadata: { exit_code: 2 } }),
      }),
      call('function_call', { name: 'shell_command', call_id: 'c2', arguments: JSON.stringify({ command: 'pwd' }) }),
      call('function_call_output', {
        call_id: 'c2',
        output: [{ type: 'input_text', text: '/w' }, { type: 'input_image' }],
      }),
      call('local_shell_call', { call_id: 'c3', action: { command: ['echo', 'hi'], working_directory: '/x' } }),
      call('local_shell_call_output', { call_id: 'c3', output: { content: 'hi' } }),
      call('function_call', { name: 'exec_command', call_id: 'c4', arguments: JSON.stringify({ cmd: 'make' }) }),
      call('function_call_output', {
        call_id: 'c4',
        output:
          'Chunk ID: 1\nWall time: 1 seconds\nProcess exited with code 2\nOriginal token count: 1\nOutput:\nfailed\n',
      }),
      call('function_call', {
        name: 'mcp__thing',
        call_id: 'c5',
        arguments: JSON.stringify({ command: 'not a shell' }),
      }),
      call('function_call_output', { call_id: 'c5', output: 'ok' }),
      call('custom_tool_call', { name: 'apply_patch', call_id: 'c6', input: '*** Begin Patch' }),
      call('custom_tool_call_output', { call_id: 'c6', output: 'Success' }),
      call('web_search_call', { id: 'ws', action: { query: 'zod docs' } }),
      call('function_call', { name: 'exec_command', call_id: 'c7', arguments: '{not json' }),
      call('function_call', { name: 'exec_command', call_id: 'c8', arguments: JSON.stringify({ cmd: 42 }) }),
      call('function_call', { call_id: 'c9' }),
      call('function_call_output', { output: 'orphan' }),
      call('mystery_item', {}),
      codexLine('event_msg', { type: 'agent_message', message: 'mirror' }),
      codexLine('response_item', null as unknown as Record<string, unknown>),
    ].join('\n');

    // Act
    const read = readCodexConversation(text, NO_DOCUMENTS);

    // Assert
    should(read.model).equal('gpt-5.5');
    should(read.dropped).deepEqual({ reasoning: 1, sidechains: 0, internal: 3, compactions: 0 });
    should(read.entries).deepEqual([
      { kind: 'user', text: 'look', attachments: [{ kind: 'image', uri: 'https://example.test/i.png' }], at: AT },
      { kind: 'shell', command: 'bash -lc ls', workdir: '/w', output: 'Exit code 2\na b', failed: true, at: AT },
      { kind: 'shell', command: 'pwd', output: '/w', failed: false, at: AT },
      { kind: 'shell', command: 'echo hi', workdir: '/x', output: 'hi', failed: false, at: AT },
      { kind: 'shell', command: 'make', output: 'Exit code 2\nfailed\n', failed: true, at: AT },
      { kind: 'tool', name: 'mcp__thing', input: 'not a shell', output: 'ok', failed: false, at: AT },
      { kind: 'tool', name: 'apply_patch', input: '*** Begin Patch', output: 'Success', failed: false, at: AT },
      { kind: 'tool', name: 'web_search', input: 'zod docs', failed: false, at: AT },
      { kind: 'tool', name: 'exec_command', input: '{not json', failed: false, at: AT },
      { kind: 'tool', name: 'exec_command', input: '{"cmd":42}', failed: false, at: AT },
      { kind: 'tool', name: 'shell', input: 'null', failed: false, at: AT },
    ]);
  });

  it('should restart from a compaction: its kept history when it has one, its summary otherwise', () => {
    // Arrange
    const before = codexLine('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'old' }],
    });
    const kept = codexLine('compacted', {
      replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kept' }] }, 7],
    });
    const summarised = codexLine('compacted', { message: '  what happened  ' });
    const blank = codexLine('compacted', { message: ' ' });

    // Act
    const fromKept = readCodexConversation([codexMeta, before, kept].join('\n'), NO_DOCUMENTS);
    const fromSummary = readCodexConversation([codexMeta, before, summarised].join('\n'), NO_DOCUMENTS);
    const fromBlank = readCodexConversation(
      [codexMeta, before, blank, JSON.stringify({ type: 'compacted' })].join('\n'),
      NO_DOCUMENTS,
    );

    // Assert
    should(fromKept.entries).deepEqual([{ kind: 'user', text: 'kept', attachments: [], at: AT }]);
    should(fromSummary.entries).deepEqual([
      { kind: 'user', text: '[Summary of the earlier conversation]\nwhat happened', attachments: [], at: AT },
    ]);
    should(fromBlank.entries).deepEqual([]);
    should(fromBlank.dropped.compactions).equal(2);
  });
});

describe('cross-harness conversion — writers and small parts', () => {
  it('should write each shape the way its harness records it', () => {
    // Arrange
    const entries = [
      { kind: 'assistant', text: 'carried on' },
      { kind: 'shell', command: 'ls', workdir: '/w', output: 'a', failed: false },
      { kind: 'tool', name: 'Read', input: 'x', failed: false },
      { kind: 'user', text: 'next' },
    ] as const;

    // Act
    const claude = writeClaudeTranscript({
      entries,
      sessionId: TARGET_ID,
      cwd: '/w',
      version: '2.1.304',
      model: 'm',
      at: AT,
    });
    const codex = writeCodexRollout({
      entries,
      threadId: TARGET_ID,
      cwd: '/w',
      version: '0.163.0',
      at: AT,
      workspaceRoots: ['/c'],
      modelProvider: 'openai',
    });

    // Assert
    const claudeRecords = claude
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    should(claudeRecords.map(record => record.type)).deepEqual(['assistant', 'user', 'assistant', 'user']);
    should(claudeRecords[0].message.content[1].input.description).equal('Carried over; ran in /w');
    should(claudeRecords[0].message.stop_reason).equal('tool_use');
    should(claudeRecords[2].message.stop_reason).equal('end_turn');
    const codexRecords = codex
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    should(codexRecords[0].payload).match({
      id: TARGET_ID,
      model_provider: 'openai',
      runtime_workspace_roots: ['/w', '/c'],
    });
    should(
      JSON.parse(codexRecords.find(record => record.payload.type === 'function_call').payload.arguments),
    ).deepEqual({ cmd: 'ls', workdir: '/w' });
    should(codexRolloutRelativePath(TARGET_ID, '2026-10-20T08:09:10.123Z')).equal(
      `sessions/2026/10/20/rollout-2026-10-20T08-09-10-${TARGET_ID}.jsonl`,
    );
    should(codexRolloutRelativePath(TARGET_ID, '')).equal(
      `sessions/1970/01/01/rollout-1970-01-01T00-00-00-${TARGET_ID}.jsonl`,
    );
  });

  it('should render tool lines, derive record ids and split exit codes', () => {
    // Arrange + Act + Assert
    should(toolLine({ kind: 'tool', name: 'Grep', input: 'TODO', failed: false })).equal(
      '[ran Grep: TODO] (no result recorded)',
    );
    should(toolLine({ kind: 'tool', name: 'Grep', input: 'TODO', output: '  ', failed: true })).equal(
      '[ran Grep: TODO] (failed) → (no output)',
    );
    should(toolLine({ kind: 'shell', command: 'ls', output: 'a\n', failed: false })).equal('[ran shell: ls] →\na');
    should(derivedUuid(TARGET_ID, 255)).equal('11111111-2222-4333-8444-0000000000ff');
    should(exitCodeOf('Exit code 4\nrest')).deepEqual({ code: 4, rest: 'rest' });
    should(exitCodeOf('fine')).deepEqual({ code: undefined, rest: 'fine' });
    should(toolInputLine(['a'])).equal('["a"]');
    should(toolInputLine({ path: ['src', 'lib'] })).equal('src lib');
    should(toolInputLine({ path: '  ', other: 1 })).equal('{"path":" ","other":1}');
    should(toolInputLine(undefined)).equal('null');
    should(parseDataUrl('data:image/png;base64,AAA=')).deepEqual({ mediaType: 'image/png', data: 'AAA=' });
    should(parseDataUrl('https://x')).be.undefined();
    should(truncated('abcdef', 3)).equal('abc… [3 more characters truncated]');
    should(oneLine(' a \n b ', 10)).equal('a b');
    should(pairTools([{ kind: 'result', id: 'x', output: '', failed: false }]).orphanResults).equal(1);
  });

  it('should parse version banners and gate both sides on the measured versions', () => {
    // Arrange + Act + Assert
    should(parseHarnessVersion('2.1.281 (Claude Code)')).deepEqual({ major: 2, minor: 1, patch: 281 });
    should(parseHarnessVersion('codex-cli 0.163.0-alpha.4')).deepEqual({ major: 0, minor: 163, patch: 0 });
    should(parseHarnessVersion('unknown')).be.undefined();
    should(harnessVersionRefusal('claude', '2.1.399', 'target')).be.undefined();
    should(harnessVersionRefusal('claude', '2.1.199', 'source')).containEql('Claude Code 2.1.199');
    should(harnessVersionRefusal('codex', '0.156.9', 'source')).be.undefined();
    should(harnessVersionRefusal('codex', 'codex-cli 0.164.0', 'target')).be.undefined();
    should(harnessVersionRefusal('codex', '0.164.7', 'source')).be.undefined();
    should(harnessVersionRefusal('codex', 'codex-cli 0.165.0', 'target')).containEql('Codex 0.165.0');
    should(harnessVersionRefusal('codex', '0.157.0', 'source')).containEql('Codex 0.157.0');
  });
});

describe('cross-harness conversion — a history that opens with the agent', () => {
  it('should put the notice in a user message of its own, so the target history still opens with the person', () => {
    // Arrange
    const text = [
      codexMeta,
      codexLine('compacted', {
        replacement_history: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'where we were' }] },
        ],
      }),
    ].join('\n');

    // Act
    const result = converted(
      convertConversation(request({ harness: 'codex', text, documents: NO_DOCUMENTS }, { harness: 'claude' })),
    );
    const back = readClaudeConversation(result.transcript, NO_DOCUMENTS);

    // Assert
    should(back.entries.map(entry => entry.kind)).deepEqual(['user', 'assistant']);
    should((back.entries[0] as { text: string }).text).startWith(CONVERSION_NOTICE_HEAD);
    should(back.model).equal('converted');
  });
});

describe('cross-harness conversion — shell commands as text', () => {
  it('should carry shell commands as text lines when the target cannot take them natively', async () => {
    // Arrange
    const text = await fixture('codex-0.163.0.jsonl');

    // Act
    const result = converted(
      convertConversation(
        request({ harness: 'codex', text, documents: NO_DOCUMENTS }, { harness: 'claude', nativeShell: false }),
      ),
    );
    const back = readClaudeConversation(result.transcript, NO_DOCUMENTS);

    // Assert
    should(result.transcript).not.containEql('"tool_use"');
    should(result.summary).match({ nativeToolCalls: 0, toolCallsAsText: 2 });
    should(result.nativeTools).deepEqual([]);
    should(said(back.entries).join('\n')).containEql('[ran shell: echo fixture-output] →\nfixture-output');
    should((back.entries[0] as { text: string }).text).containEql(
      '. Tool activity from Codex is shown as text, and those tools',
    );
  });
});
