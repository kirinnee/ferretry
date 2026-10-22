/**
 * THE INCREMENTAL TAIL IS THE FRESH TAIL.
 *
 * A session worker keeps one {@link IncrementalTranscriptTail} per hosted transcript and steps it as the
 * agent writes, instead of re-reading the whole tail window on every look. Here a real transcript source
 * reads a real file appended in random chunk sizes — a line split across appends, a four-byte character
 * split across appends — and after EVERY append the held tail must equal `tailTranscriptEvents` of the
 * file as it is then, while opening no new window once it is sliding.
 */
import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeTranscriptSource } from '../../../../src/adapters/transcript/index.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  IncrementalTranscriptTail,
  type TranscriptSource,
  tailTranscriptEvents,
} from '../../../../src/lib/index.ts';
import type { TranscriptWindowOptions } from '../../../../src/lib/transcript/types.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const AT = Date.parse('2026-10-22T08:00:00.000Z');
const LIMIT = 400;

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-incremental-tail-'));
  cleanups.push(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

/** A deterministic generator, so a failing chunk sequence is the same one every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One Claude exchange — prompt, reply with a tool call, tool result — with multi-byte text in it. */
function claudeExchange(n: number): string {
  const timestamp = new Date(AT + n * 1_000).toISOString();
  const user = {
    type: 'user',
    sessionId: 's',
    uuid: `u-${String(n)}`,
    timestamp,
    message: { role: 'user', content: `Step ${String(n)} — café 😀 naïve` },
  };
  const assistant = {
    type: 'assistant',
    sessionId: 's',
    uuid: `a-${String(n)}`,
    parentUuid: user.uuid,
    timestamp,
    message: {
      id: `msg-${String(n)}`,
      role: 'assistant',
      model: 'claude-opus-4-1',
      content: [
        { type: 'text', text: `Working on ${String(n)}. ${'Reading the module. '.repeat(6)}` },
        { type: 'tool_use', id: `toolu-${String(n)}`, name: 'Read', input: { file_path: '/src/a.ts' } },
      ],
      usage: { input_tokens: 1_200, output_tokens: 340 },
    },
  };
  const result = {
    type: 'user',
    sessionId: 's',
    uuid: `r-${String(n)}`,
    parentUuid: assistant.uuid,
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `toolu-${String(n)}`, content: 'x'.repeat(1_200) }],
    },
  };
  return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n${JSON.stringify(result)}\n`;
}

/** One Codex turn: an assistant message and a token count. */
function codexTurn(n: number): string {
  const timestamp = new Date(AT + n * 1_000).toISOString();
  const message = {
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `ü ${'y'.repeat(500)}` }] },
  };
  const tokens = {
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: 1 } } },
  };
  return `${JSON.stringify(message)}\n${JSON.stringify(tokens)}\n`;
}

const exchanges = (render: (n: number) => string, from: number, count: number): string =>
  Array.from({ length: count }, (_, index) => render(from + index)).join('');

/** A source that counts the windows it opened: a sliding tail opens none. */
function counted(source: TranscriptSource): { readonly source: TranscriptSource; readonly windows: () => number } {
  let windows = 0;
  return {
    source: {
      harness: source.harness,
      read: (file, options) => source.read(file, options),
      follow: (file, options) => source.follow(file, options),
      window: (file: string, options: TranscriptWindowOptions) => {
        windows += 1;
        return source.window(file, options);
      },
    },
    windows: () => windows,
  };
}

/**
 * Appends `text` in random chunk sizes, with cuts forced inside its first four-byte character and in the
 * middle of its first line, comparing the held tail with a fresh one after every append.
 */
async function appendComparing(
  file: string,
  text: string,
  tail: IncrementalTranscriptTail,
  source: TranscriptSource,
  next: () => number,
  maxChunk: number,
): Promise<number> {
  const bytes = Buffer.from(text, 'utf8');
  const emoji = bytes.indexOf(Buffer.from('😀', 'utf8'));
  const cuts = new Set([emoji + 2, Math.floor(bytes.indexOf(0x0a) / 2)].filter(cut => cut > 0));
  let compared = 0;
  for (let at = 0; at < bytes.length; ) {
    const forced = [...cuts].filter(cut => cut > at).sort((a, b) => a - b)[0];
    const random = at + 1 + Math.floor(next() * maxChunk);
    const end = Math.min(bytes.length, forced === undefined ? random : Math.min(random, forced));
    await appendFile(file, bytes.subarray(at, end));
    at = end;
    const held = await tail.read();
    const fresh = await tailTranscriptEvents(source, file, 's', LIMIT);
    should(held).deepEqual(fresh);
    compared += 1;
  }
  return compared;
}

describe('IncrementalTranscriptTail', () => {
  it('should equal a fresh tail after every append of a Claude transcript, without opening a window', async () => {
    // Arrange — a megabyte already written: the 512 KiB window begins mid-file and holds the limit.
    const file = join(await directory(), 'claude.jsonl');
    await writeFile(file, exchanges(claudeExchange, 0, 450));
    const real = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const { source, windows } = counted(real);
    const tail = new IncrementalTranscriptTail(source, file, 's', LIMIT);
    should(await tail.read()).deepEqual(await tailTranscriptEvents(real, file, 's', LIMIT));
    const opened = windows();

    // Act
    const compared = await appendComparing(file, exchanges(claudeExchange, 450, 120), tail, real, random(7), 4_000);

    // Assert
    should(compared).be.above(60);
    should(windows()).equal(opened);
  }, 120_000);

  it('should equal a fresh tail after every append of a Codex rollout', async () => {
    // Arrange
    const file = join(await directory(), 'rollout.jsonl');
    await writeFile(file, exchanges(codexTurn, 0, 1_200));
    const real = new NodeTranscriptSource(new CodexTranscriptParser());
    const { source, windows } = counted(real);
    const tail = new IncrementalTranscriptTail(source, file, 's', LIMIT);
    await tail.read();
    const opened = windows();

    // Act
    const compared = await appendComparing(file, exchanges(codexTurn, 1_200, 120), tail, real, random(11), 2_000);

    // Assert
    should(compared).be.above(30);
    should(windows()).equal(opened);
  }, 120_000);

  it('should read a small transcript afresh until it holds the limit mid-file, and still equal a fresh tail', async () => {
    // Arrange — a few exchanges: the window began at byte zero, where events carry line numbers.
    const file = join(await directory(), 'small.jsonl');
    await writeFile(file, exchanges(claudeExchange, 0, 5));
    const real = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const tail = new IncrementalTranscriptTail(real, file, 's', LIMIT);
    await tail.read();

    // Act — grows past the first window in big chunks.
    const compared = await appendComparing(file, exchanges(claudeExchange, 5, 300), tail, real, random(3), 40_000);

    // Assert
    should(compared).be.above(10);
  }, 120_000);

  it('should read afresh once the file was replaced or truncated', async () => {
    // Arrange
    const root = await directory();
    const file = join(root, 'claude.jsonl');
    await writeFile(file, exchanges(claudeExchange, 0, 450));
    const real = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const tail = new IncrementalTranscriptTail(real, file, 's', LIMIT);
    await tail.read();
    await appendFile(file, exchanges(claudeExchange, 450, 3));
    await tail.read();

    // Act — a different conversation renamed over it, then cut short.
    await writeFile(join(root, 'next.jsonl'), exchanges(claudeExchange, 10_000, 400));
    await rename(join(root, 'next.jsonl'), file);
    const replaced = await tail.read();
    const replacedFresh = await tailTranscriptEvents(real, file, 's', LIMIT);
    await truncate(file, 200_000);
    const truncated = await tail.read();
    const truncatedFresh = await tailTranscriptEvents(real, file, 's', LIMIT);

    // Assert
    should(replaced).deepEqual(replacedFresh);
    should(truncated).deepEqual(truncatedFresh);
  }, 120_000);

  it('should read afresh once its window has grown past the widest a fresh tail reads', async () => {
    // Arrange — a 1 MiB bound: the 512 KiB window may slide 512 KiB, no further.
    const file = join(await directory(), 'claude.jsonl');
    await writeFile(file, exchanges(claudeExchange, 0, 450));
    const real = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const { source, windows } = counted(real);
    const tail = new IncrementalTranscriptTail(source, file, 's', LIMIT, 1024 * 1024);
    await tail.read();
    const opened = windows();

    // Act
    await appendFile(file, exchanges(claudeExchange, 450, 100));
    const within = await tail.read();
    const withinFresh = await tailTranscriptEvents(real, file, 's', LIMIT, 1024 * 1024);
    const slid = windows();
    await appendFile(file, exchanges(claudeExchange, 550, 200));
    const beyond = await tail.read();

    // Assert
    should(slid).equal(opened);
    should(within).deepEqual(withinFresh);
    should(windows()).be.above(slid);
    should(beyond).deepEqual(await tailTranscriptEvents(real, file, 's', LIMIT, 1024 * 1024));
  }, 120_000);

  it('should throw like a fresh tail when the file cannot be read, and recover once it can', async () => {
    // Arrange
    const root = await directory();
    const file = join(root, 'claude.jsonl');
    const real = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const tail = new IncrementalTranscriptTail(real, file, 's', LIMIT);

    // Act
    const missing = await tail.read();
    await writeFile(file, exchanges(claudeExchange, 0, 2));
    const present = await tail.read();

    // Assert
    should(missing).deepEqual(await tailTranscriptEvents(real, join(root, 'gone.jsonl'), 's', LIMIT));
    should(present).deepEqual(await tailTranscriptEvents(real, file, 's', LIMIT));
  }, 60_000);
});
