import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  type FerretId,
  type HarnessTranscriptBytes,
  HarnessTranscriptReplaced,
  type TranscriptEntry,
} from '@ferretry/core-ferrets/contract';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { registerReader } from '../../../daemon/reader/index.ts';
import { claudeText, claudeUserImage, pngBase64 } from '../../support/transcript-images.ts';

/**
 * The reader over a harness's RAW transcript bytes (G162), through the real routes. The only stand-ins are the harness
 * (an in-memory file that can be replaced) and the vault (one fixture secret, masked by a read-scoped redactor).
 */

const SECRET = 'hunter2';
const stamp = (n: number): string => new Date(Date.UTC(2026, 1, 1) + n * 1_000).toISOString();

const user = (n: number, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid: `u-${String(n)}`,
    timestamp: stamp(n),
    sessionId: 's1',
    message: { role: 'user', content: text },
  });

/** One assistant record: thinking, a sentence and a tool call, as Claude writes them. */
const assistantWithTool = (n: number, thought: string, text: string, command: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a-${String(n)}`,
    timestamp: stamp(n),
    sessionId: 's1',
    message: {
      id: `m-${String(n)}`,
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: thought, signature: 'sig' },
        { type: 'text', text },
        { type: 'tool_use', id: `tool-${String(n)}`, name: 'Bash', input: { command } },
      ],
    },
  });

const toolResult = (n: number, output: string): string =>
  JSON.stringify({
    type: 'user',
    uuid: `r-${String(n)}`,
    timestamp: stamp(n),
    sessionId: 's1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tool-${String(n - 1)}`, content: output }],
    },
  });

/** A conversation with a tool call, thinking, a tool result, an image and the fixture secret in every kind. */
const conversation = (): string[] => [
  user(1, `please deploy, the token is ${SECRET}`),
  assistantWithTool(
    2,
    `the token ${SECRET} must not be echoed`,
    `deploying with ${SECRET}`,
    `deploy --token ${SECRET}`,
  ),
  toolResult(3, `deployed using ${SECRET}`),
  claudeUserImage(4, [pngBase64(24)]),
  claudeText(5),
];

const bytesOf = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join('\n')}\n`);

/** The harness's file: one at a time, and a new one replaces it (the old handle then rejects, as a harness's does). */
class Disk {
  #current: { readonly token: string; readonly bytes: Uint8Array } | undefined;
  #opened = 0;
  format: 'claude' | 'codex' = 'claude';
  /** Every handle opened, and whether the consumer closed it: the reader must close what it opens. */
  readonly handles: { closed: boolean }[] = [];
  off = false;
  /** Whether the harness offers bytes at all; `false` is a harness that only keeps entries. */
  offers = true;

  put(lines: readonly string[]): void {
    this.#opened += 1;
    this.#current = { token: `file-${String(this.#opened)}`, bytes: bytesOf(lines) };
  }

  clear(): void {
    this.#current = undefined;
  }

  readonly open = async (): Promise<HarnessTranscriptBytes | undefined | 'unsupported'> => {
    if (this.off) throw new ApiError(503, 'the harness is off', 'plugin_unavailable');
    if (!this.offers) return 'unsupported';
    const opened = this.#current;
    if (opened === undefined) return undefined;
    const state = { closed: false };
    this.handles.push(state);
    const still = (): boolean => this.#current === opened;
    return {
      format: this.format,
      file: opened.token,
      size: opened.bytes.byteLength,
      mtimeMs: 1,
      read: async (offset, length) => {
        if (state.closed) throw new Error('closed');
        if (!still()) throw new HarnessTranscriptReplaced();
        return opened.bytes.slice(offset, offset + length);
      },
      stat: async () => (still() && !state.closed ? { size: opened.bytes.byteLength, mtimeMs: 1 } : undefined),
      close: async () => {
        state.closed = true;
      },
    };
  };
}

const mask = (text: string): string => text.replaceAll(SECRET, '[redacted]');

const entries: TranscriptEntry[] = [
  { id: 'e1', at: '2026-02-01T09:00:01.000Z' as Instant, role: 'user', text: 'entries only hello' },
  { id: 'e2', at: '2026-02-01T09:00:02.000Z' as Instant, role: 'assistant', text: 'entries only reply' },
];

const reader = (disk: Disk) =>
  registerReader({
    bytes: disk.open,
    transcripts: async () => ({
      harness: 'claude' as const,
      reader: {
        read: async (_ferret: FerretId, after?: string) => (after === undefined ? entries : []),
        follow: () => (async function* () {})(),
        find: async () => undefined,
      },
    }),
    exists: async ferret => ferret === 'lead',
    codec: {
      tag: async input => new Uint8Array(createHmac('sha256', 'k').update(input).digest()),
      matches: async (input, tag) =>
        Buffer.from(createHmac('sha256', 'k').update(input).digest()).equals(Buffer.from(tag)),
    },
    redactor: {
      redact: async text => mask(text),
      batch: async work => work({ text: mask, data: value => JSON.parse(mask(JSON.stringify(value))) as unknown }),
    },
    now: () => 0,
  });

const call = (query: Record<string, string> = {}, params: Record<string, string> = {}) =>
  ({
    request: {
      query: new Map(Object.entries(query).map(([key, value]) => [key, [value]])),
      headers: { get: () => undefined },
      text: async () => '',
    } as unknown as ApiRequest,
    params: new Map(Object.entries({ ferretId: 'lead', ...params })),
  }) as never;

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as { status: number; code?: string },
  );

const LOGS = 'GET /v1/ferrets/:ferretId/logs';
const PAGE = 'GET /v1/ferrets/:ferretId/log-page';
const SEARCH = 'GET /v1/ferrets/:ferretId/log-search';
const MESSAGES = 'GET /v1/ferrets/:ferretId/messages';
const IMAGE = 'GET /v1/ferrets/:ferretId/transcript-images/:handle';

describe('a ferret’s transcript read from the harness bytes', () => {
  test('logs render the tool call, its result, the thinking and the image, and mask the secret everywhere', async () => {
    const disk = new Disk();
    disk.put(conversation());
    const { routes } = reader(disk);

    const body = (await routes[LOGS](call())).body;

    expect(body).toContain('Bash');
    expect(body).toContain('deploy --token [redacted]');
    expect(body).toContain('deployed using [redacted]');
    expect(body).toContain('assistant/reasoning');
    expect(body).toContain('fy-image');
    expect(body).not.toContain(SECRET);
  });

  test('log-page carries every kind of event, the file token, and no secret', async () => {
    const disk = new Disk();
    disk.put(conversation());
    const { routes } = reader(disk);

    const raw = (await routes[PAGE](call())).body;
    const page = JSON.parse(raw) as { file: string; start: number; log: string };

    expect(raw).not.toContain(SECRET);
    expect(page.file).toBe('file-1');
    expect(page.start).toBe(0);
    expect(page.log).toContain('tool-call');
    expect(page.log).toContain('tool-result');
    expect(page.log).toContain('assistant/reasoning');
    expect(page.log).toContain('fy-image');
  });

  test('an image handle the logs print resolves through transcript-images', async () => {
    const disk = new Disk();
    disk.put(conversation());
    const { routes } = reader(disk);
    const logs = (await routes[LOGS](call())).body;
    const handle = /\[fy-image ([0-9.]+) /u.exec(logs)?.[1];
    expect(handle).toBeDefined();

    const served = await routes[IMAGE](call({}, { handle: handle as string }));

    expect(served.status).toBe(200);
    expect(JSON.parse(served.body)).toMatchObject({ image: { mediaType: 'image/png' } });
  });

  test('log-search finds a word and masks the secret in the snippet', async () => {
    const disk = new Disk();
    disk.put(conversation());
    const { routes } = reader(disk);

    const raw = (await routes[SEARCH](call({ q: 'deploy' }))).body;

    expect(raw).toContain('deploy');
    expect(raw).not.toContain(SECRET);
  });

  test('messages are bounded rows and mask the secret', async () => {
    const disk = new Disk();
    disk.put(conversation());
    const { routes } = reader(disk);

    const raw = (await routes[MESSAGES](call({ limit: '10' }))).body;
    const page = JSON.parse(raw) as { messages: { text: string }[] };

    expect(raw).not.toContain(SECRET);
    expect(page.messages.map(message => message.text)).toContain('please deploy, the token is [redacted]');
  });

  test('an older page is served for its file, and refused once the transcript is another file', async () => {
    const disk = new Disk();
    disk.put([...Array.from({ length: 12 }, (_, index) => user(index + 1, `line ${String(index + 1)}`))]);
    const { routes } = reader(disk);
    const first = JSON.parse((await routes[PAGE](call({ limit: '3' }))).body) as { file: string; start: number };

    const older = await routes[PAGE](call({ before: String(first.start), file: first.file, limit: '3' }));
    disk.put([user(1, 'a different file')]);
    const stale = await refusal(
      Promise.resolve(routes[PAGE](call({ before: String(first.start), file: first.file, limit: '3' }))),
    );

    expect(older.status).toBe(200);
    expect(stale).toMatchObject({ status: 409, code: 'log_cursor_stale' });
  });

  test('a message cursor goes stale once the transcript file is replaced', async () => {
    const disk = new Disk();
    disk.put(Array.from({ length: 6 }, (_, index) => user(index + 1, `line ${String(index + 1)}`)));
    const { routes } = reader(disk);
    const first = JSON.parse((await routes[MESSAGES](call({ limit: '2' }))).body) as { nextCursor: string };

    disk.put(Array.from({ length: 6 }, (_, index) => user(index + 1, `other ${String(index + 1)}`)));
    const stale = await refusal(Promise.resolve(routes[MESSAGES](call({ cursor: first.nextCursor }))));

    expect(stale).toMatchObject({ status: 409, code: 'message_cursor_stale' });
  });

  test('a ferret with no proved transcript reads as no_transcript, never as an empty page', async () => {
    const disk = new Disk();
    const { routes } = reader(disk);

    const logs = await refusal(Promise.resolve(routes[LOGS](call())));
    const page = await refusal(Promise.resolve(routes[PAGE](call())));
    const messages = await refusal(Promise.resolve(routes[MESSAGES](call())));

    for (const answer of [logs, page, messages]) expect(answer).toMatchObject({ status: 409, code: 'no_transcript' });
  });

  test('a harness that is off answers its own 503 plugin_unavailable', async () => {
    const disk = new Disk();
    disk.put(conversation());
    disk.off = true;
    const { routes } = reader(disk);

    const answer = await refusal(Promise.resolve(routes[LOGS](call())));

    expect(answer).toMatchObject({ status: 503, code: 'plugin_unavailable' });
  });

  test('a harness that offers no bytes is read through its entries, thinner but honest', async () => {
    const disk = new Disk();
    disk.offers = false;
    const { routes } = reader(disk);

    const body = (await routes[LOGS](call())).body;

    expect(body).toContain('entries only hello');
    expect(body).toContain('entries only reply');
  });

  test('the reader keeps one open handle per ferret however many reads it serves, and closes them all on close', async () => {
    const disk = new Disk();
    disk.put(conversation());
    const reading = reader(disk);

    for (let index = 0; index < 5; index += 1) await reading.routes[LOGS](call());
    await reading.routes[PAGE](call());
    await reading.routes[SEARCH](call({ q: 'deploy' }));
    await reading.routes[MESSAGES](call({ limit: '10' }));
    // Let the closes of the duplicates (fire and forget) settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(disk.handles.filter(handle => !handle.closed)).toHaveLength(1);

    await reading.close();

    expect(disk.handles.every(handle => handle.closed)).toBe(true);
  });

  test('a replaced transcript closes the handle on the old file', async () => {
    const disk = new Disk();
    disk.put(conversation());
    const reading = reader(disk);
    await reading.routes[LOGS](call());
    disk.put(conversation().slice(0, 3));

    await reading.routes[LOGS](call());
    await Promise.resolve();
    await Promise.resolve();

    expect(disk.handles.filter(handle => !handle.closed)).toHaveLength(1);
    expect(disk.handles[0]?.closed).toBe(true);
  });

  test('a transcript that grew is read again, not served from before', async () => {
    const disk = new Disk();
    disk.put(conversation().slice(0, 2));
    const { routes } = reader(disk);
    const before = (await routes[LOGS](call())).body;

    disk.put(conversation());
    const after = (await routes[LOGS](call())).body;

    expect(before).not.toContain('deployed using');
    expect(after).toContain('deployed using [redacted]');
  });
});
