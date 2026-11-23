import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { FerretId, HarnessTranscriptBytes, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { ApiRequest } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { registerReader } from '../../../daemon/reader/index.ts';
import { ClaudeTranscriptParser } from '../../../daemon/reader/lib/transcript/claude.ts';
import type { TranscriptParser } from '../../../daemon/reader/lib/transcript/types.ts';

/**
 * The transcript parser is a harness-DECLARED id (runtimes plan U4a), not a closed pair: a harness whose
 * `HarnessFacts.transcriptFormat` is `fake-jsonl` is read by the parser registered under that id, and a harness whose
 * format has NO parser is read through the entries fallback, never as Claude or Codex. Fixture values only.
 */

const THIRD_FORMAT = 'fake-jsonl';

/** A third harness's parser: its own id over the Claude record shape (all the fake harness writes). */
const thirdParser = (): TranscriptParser => {
  const base = new ClaudeTranscriptParser();
  return {
    harness: THIRD_FORMAT,
    ...(base.ignoredRecordKeys === undefined ? {} : { ignoredRecordKeys: base.ignoredRecordKeys }),
    parse: (input, observer) => base.parse(input, observer),
    parseRecord: (value, context) => base.parseRecord(value, context),
    createInputObserver: () => base.createInputObserver(),
  };
};

const line = JSON.stringify({
  type: 'user',
  uuid: 'u-1',
  timestamp: '2026-02-01T09:00:01.000Z',
  sessionId: 's1',
  message: { role: 'user', content: 'hello from the third harness' },
});

const entries: TranscriptEntry[] = [
  { id: 'e1', at: '2026-02-01T09:00:01.000Z' as Instant, role: 'user', text: 'entries only hello' },
];

/** The third harness's transcript bytes: one file, in whatever format id it declares. */
const bytesOf = (format: string) => async (): Promise<HarnessTranscriptBytes> => {
  const bytes = new TextEncoder().encode(`${line}\n`);
  return {
    format,
    file: 'third-file-1',
    size: bytes.byteLength,
    mtimeMs: 1,
    read: async (offset, length) => bytes.slice(offset, offset + length),
    stat: async () => ({ size: bytes.byteLength, mtimeMs: 1 }),
    close: async () => {},
  };
};

const reader = (format: string, parsers: readonly TranscriptParser[]) =>
  registerReader({
    bytes: bytesOf(format),
    transcripts: async () => ({
      harness: 'claude' as const,
      reader: {
        read: async (_ferret: FerretId, after?: string) => (after === undefined ? entries : []),
        follow: () => (async function* () {})(),
        find: async () => undefined,
      },
    }),
    exists: async () => true,
    codec: {
      tag: async input => new Uint8Array(createHmac('sha256', 'k').update(input).digest()),
      matches: async (input, tag) =>
        Buffer.from(createHmac('sha256', 'k').update(input).digest()).equals(Buffer.from(tag)),
    },
    redactor: { redact: async text => text, batch: async work => work({ text: value => value, data: value => value }) },
    now: () => 0,
    parsers,
  });

const logs = async (routes: ReturnType<typeof reader>['routes']): Promise<string> =>
  (
    await routes['GET /v1/ferrets/:ferretId/logs']({
      request: {
        query: new Map(),
        headers: { get: () => undefined },
        text: async () => '',
      } as unknown as ApiRequest,
      params: new Map([['ferretId', 'third']]),
    } as never)
  ).body;

describe('a transcript format a harness declares', () => {
  test('is read by the parser registered under its id', async () => {
    const { routes } = reader(THIRD_FORMAT, [thirdParser()]);

    const body = await logs(routes);

    expect(body).toContain('hello from the third harness');
    expect(body).not.toContain('entries only hello');
  });

  test('with no parser registered is never read as another format: the entries fallback answers', async () => {
    const { routes } = reader('format-nobody-parses', [thirdParser()]);

    const body = await logs(routes);

    expect(body).toContain('entries only hello');
    expect(body).not.toContain('hello from the third harness');
  });
});
