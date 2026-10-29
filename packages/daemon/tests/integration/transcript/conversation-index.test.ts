import { afterAll, describe, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { appendFile, open, rename, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import {
  LOOP_PARSE_PACING,
  NodeTranscriptFileRuntime,
  NodeTranscriptSource,
  type TranscriptReadLimits,
} from '../../../src/adapters/transcript/file-source.ts';
import {
  type OperatorMessageSource,
  OperatorReadError,
  OperatorReadService,
} from '../../../src/lib/session/reads/index.ts';
import {
  ConversationIndex,
  extendSessionTranscriptRawPrefix,
  type SessionTranscriptMessageTokenCodec,
  type SessionTranscriptMessageTokenContext,
  SessionTranscriptReader,
  sessionTranscriptRawPrefixStart,
  tailTranscriptEvents,
} from '../../../src/lib/session/transcript/index.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * A messages page over a REAL transcript file, through the conversation index the daemon composes.
 *
 * Every page used to be one complete read from byte zero, bounded at 32 MiB: a long session answered
 * `transcript_unreadable`, and so did a live one whose last line was half-written. These cases page the
 * same files through the real source, the real index and the real service with real cursors, so a page
 * that is served is one whose cursor verifies, and a cursor that should go stale does.
 */

const SESSION = '11111111-1111-4111-8111-111111111111';
const MiB = 1024 * 1024;
const KEY = Buffer.from('conversation index integration key', 'utf8');

const codec: SessionTranscriptMessageTokenCodec = {
  tag: async input => new Uint8Array(createHmac('sha256', KEY).update(input).digest()),
  matches: async (input, tag) => Buffer.from(createHmac('sha256', KEY).update(input).digest()).equals(Buffer.from(tag)),
};

const context = (file: string): SessionTranscriptMessageTokenContext => ({
  sessionId: SESSION,
  incarnation: 'inc-one',
  provenance: {
    v: 1,
    home: '/harness/home',
    identity: 'minted',
    harnessSessionId: 'harness-one',
    file,
    resolvedAt: '2026-10-29T00:00:00.000Z',
  },
});

let stamp = 0;
const base = { sessionId: SESSION, parentUuid: null, cwd: '/work', version: '2.1.0' };
const at = (): string => {
  stamp += 1;
  return new Date(Date.UTC(2026, 0, 1) + stamp * 1_000).toISOString();
};

/** A Claude user record. */
const user = (text: string): string =>
  `${JSON.stringify({ ...base, type: 'user', uuid: `u-${String(stamp)}`, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;

/** A Claude assistant record that reports usage, as every real one does: record-level evidence beside block 0. */
const assistant = (text: string): string =>
  `${JSON.stringify({
    ...base,
    type: 'assistant',
    uuid: `a-${String(stamp)}`,
    timestamp: at(),
    message: {
      id: `m-${String(stamp)}`,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 2, output_tokens: 93, cache_read_input_tokens: 41_943 },
    },
  })}\n`;

/** A pasted screenshot: one record of `bytes`, almost all of it one base64 string. */
const screenshot = (bytes: number): string =>
  `${JSON.stringify({
    ...base,
    type: 'user',
    uuid: `s-${String(stamp)}`,
    timestamp: at(),
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'What is wrong on this screen?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(Math.ceil(bytes / 11)) },
        },
      ],
    },
  })}\n`;

const exchange = (index: number): string =>
  user(`question ${String(index)} ${'about the code '.repeat(20)}`) +
  assistant(`answer ${String(index)} ${'reading the file '.repeat(20)}`);

/** Writes `exchanges` question/answer pairs to `file` in blocks, so a large file never sits in one string. */
async function writeConversation(file: string, exchanges: number, from = 0): Promise<void> {
  const handle = await open(file, 'a');
  try {
    for (let block = from; block < from + exchanges; block += 1_000) {
      const end = Math.min(from + exchanges, block + 1_000);
      await handle.write(Array.from({ length: end - block }, (_, offset) => exchange(block + offset)).join(''));
    }
  } finally {
    await handle.close();
  }
}

interface Harness {
  readonly service: OperatorReadService;
  readonly index: ConversationIndex;
}

/** The daemon's composition of one messages read, over `file`, with `limits` on the bounded reads. */
function harness(file: string, limits: TranscriptReadLimits = {}): Harness {
  const source = new NodeTranscriptSource(new ClaudeTranscriptParser(), undefined, undefined, limits);
  const index = new ConversationIndex([source], new NodeTranscriptFileRuntime(), LOOP_PARSE_PACING);
  const reader = new SessionTranscriptReader(
    [source],
    { file: async () => file },
    { assertReadable: async () => undefined },
    index,
  );
  const messages: OperatorMessageSource = {
    read: async sessionId => {
      try {
        const rows = await reader.portableRowsFromFile({ sessionId, harness: 'claude' }, file);
        return rows === undefined ? { kind: 'unreadable' } : { kind: 'read', context: context(file), rows };
      } catch (error) {
        return { kind: 'unreadable', reason: (error as Error).message };
      }
    },
  };
  const service = new OperatorReadService(
    { replay: async () => [] },
    { capture: async () => undefined },
    { tail: async () => ({ kind: 'read', events: [] }) },
    messages,
    codec,
  );
  return { service, index };
}

/** Every page from the start, each one asked for with the cursor the last one issued. */
async function walk(service: OperatorReadService, limit = 1_000): Promise<{ texts: string[]; pages: number }> {
  const texts: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await service.messages(SESSION, cursor, limit);
    pages += 1;
    for (const message of page.messages) texts.push(message.text);
    if (page.nextCursor === null) return { texts, pages };
    cursor = page.nextCursor;
  }
}

/** The raw-prefix chain over every line of `bytes`, folded independently of the parser. */
function chainOver(bytes: Buffer): Uint8Array {
  let chain = sessionTranscriptRawPrefixStart();
  for (let from = 0; from < bytes.byteLength; ) {
    const feed = bytes.indexOf(0x0a, from);
    const to = feed < 0 ? bytes.byteLength : feed + 1;
    chain = extendSessionTranscriptRawPrefix(chain, bytes.subarray(from, to));
    from = to;
  }
  return chain;
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('a messages read over a transcript past one bounded read', () => {
  it('should page every row of it, each page asked for with the last cursor', async () => {
    // Arrange — past the 32 MiB a complete read stops at.
    const file = join(await tempDirectory('fyd-conversation-index-'), 'long.jsonl');
    await writeConversation(file, 40_000);
    const { size } = await Bun.file(file).stat();
    const { service, index } = harness(file);

    // Act
    const { texts, pages } = await walk(service);

    // Assert — every exchange, in order, across pages whose cursors all verified.
    should(size).be.above(32 * MiB);
    should(texts).have.length(80_000);
    should(texts[0]).startWith('question 0 ');
    should(texts.at(-1)).startWith('answer 39999 ');
    should(pages).equal(80);
    // The last row is bound to the chain over EVERY byte of the file, folded here without the parser.
    const rows = await index.rows({ sessionId: SESSION, harness: 'claude' }, file);
    should(
      Buffer.from(rows?.at(-1)?.rawPrefix ?? []).equals(
        Buffer.from(chainOver((await Bun.file(file).bytes()) as Buffer)),
      ),
    ).be.true();
  }, 60_000);
});

describe('a messages read over a transcript that changes between pages', () => {
  it('should keep the next cursor valid across an append, and serve what was appended', async () => {
    // Arrange
    const file = join(await tempDirectory('fyd-conversation-index-'), 'append.jsonl');
    await writeConversation(file, 300);
    const { service } = harness(file);
    const first = await service.messages(SESSION, undefined, 200);

    // Act
    await writeConversation(file, 50, 300);
    const second = await service.messages(SESSION, first.nextCursor ?? undefined, 1_000);

    // Assert
    should(second.messages).have.length(500);
    should(second.messages[0]?.text).startWith('question 100 ');
    should(second.messages.at(-1)?.text).startWith('answer 349 ');
    should(second.nextCursor).be.null();
  });

  it('should stale a cursor whose prefix was truncated, rewritten or replaced', async () => {
    // Arrange — three files, one change each, every change at or before the cursor's anchor.
    const directory = await tempDirectory('fyd-conversation-index-');
    const changes: Record<string, (file: string) => Promise<void>> = {
      truncated: async file => await truncate(file, 1_000),
      rewritten: async file => {
        stamp = 0;
        await writeFile(file, '');
        await writeConversation(file, 300);
      },
      replaced: async file => {
        stamp = 0;
        await writeConversation(`${file}.next`, 300);
        await rename(`${file}.next`, file);
      },
    };
    const outcomes: Record<string, string> = {};

    for (const [name, change] of Object.entries(changes)) {
      const file = join(directory, `${name}.jsonl`);
      await writeConversation(file, 300);
      const { service } = harness(file);
      const first = await service.messages(SESSION, undefined, 200);

      // Act
      await change(file);
      outcomes[name] = await service.messages(SESSION, first.nextCursor ?? undefined, 200).then(
        () => 'served',
        (error: unknown) => (error instanceof OperatorReadError ? error.failure : 'threw'),
      );
    }

    // Assert — the conversation the first page claimed is gone, so continuing would stitch two together.
    should(outcomes).eql({
      truncated: 'message_cursor_stale',
      rewritten: 'message_cursor_stale',
      replaced: 'message_cursor_stale',
    });
  });
});

describe('a messages read over a live transcript', () => {
  it('should serve a transcript whose last line is still being written, and the line once it is whole', async () => {
    // Arrange
    const file = join(await tempDirectory('fyd-conversation-index-'), 'live.jsonl');
    await writeConversation(file, 2);
    const next = user('the line being written');
    await appendFile(file, next.slice(0, 60));
    const { service } = harness(file);

    // Act
    const during = await service.messages(SESSION, undefined, undefined);
    await appendFile(file, next.slice(60));
    const after = await service.messages(SESSION, undefined, undefined);

    // Assert
    should(during.messages.map(each => each.text.split(' ')[0])).eql(['question', 'answer', 'question', 'answer']);
    should(after.messages.at(-1)?.text).equal('the line being written');
  });
});

describe('a messages read over a transcript holding a record past the old 4 MiB bound', () => {
  it('should serve a 6 MiB screenshot record split across bounded reads, and refuse one past the record bound', async () => {
    // Arrange — 1 MiB reads, so the record is carried across six of them.
    const file = join(await tempDirectory('fyd-conversation-index-'), 'screenshot.jsonl');
    await writeConversation(file, 1);
    await appendFile(file, screenshot(6 * MiB));
    await writeConversation(file, 1, 1);
    const served = harness(file, { maxReadBytes: MiB });
    const bounded = harness(file, { maxReadBytes: MiB, maxPendingBytes: 4 * MiB });

    // Act
    const page = await served.service.messages(SESSION, undefined, undefined);
    const refused = await bounded.service.messages(SESSION, undefined, undefined).catch((error: unknown) => error);

    // Assert
    should(page.messages.map(each => each.text.split(' ')[0])).eql([
      'question',
      'answer',
      'What',
      'question',
      'answer',
    ]);
    should(refused).be.instanceOf(OperatorReadError);
    should((refused as OperatorReadError).failure).equal('transcript_unreadable');
    should((refused as OperatorReadError).message).match(/oversized-record/);
  });
});

describe('a tail of a transcript that ends in a record longer than its first window', () => {
  it('should widen to find the events before it, rather than answer none', async () => {
    // Arrange
    const file = join(await tempDirectory('fyd-conversation-index-'), 'tail.jsonl');
    await writeConversation(file, 25);
    await appendFile(file, screenshot(3 * MiB));

    // Act
    const events = await tailTranscriptEvents(
      new NodeTranscriptSource(new ClaudeTranscriptParser()),
      file,
      SESSION,
      400,
    );

    // Assert
    const messages = events.filter(each => each.kind === 'message');
    should(messages).have.length(51);
    should(messages.at(-1)?.kind === 'message' && messages.at(-1)?.text).equal('What is wrong on this screen?');
  });
});
