import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { FerretId, HarnessTranscriptBytes } from '@ferretry/core-ferrets/contract';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { registerReader } from '../../../daemon/reader/index.ts';
import { handleOf, mkdtemp, rm, writeFile } from '../../support/disk-files.ts';

/**
 * The reader's handle lifecycle and its refusals, over a REAL transcript file on disk. The harness is the only
 * stand-in: it opens a real descriptor on the file (as the kernel's root handle does) and lets a test make that
 * handle stop answering, or fail the way a failing disk does.
 */

const stamp = (n: number): string => new Date(Date.UTC(2026, 1, 1) + n * 1_000).toISOString();
const user = (n: number, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid: `u-${String(n)}`,
    timestamp: stamp(n),
    sessionId: 's1',
    message: { role: 'user', content: text },
  });

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** A harness over one real file: every handle it opens holds a real descriptor, and is counted until it is closed. */
class RealHarness {
  readonly handles: { closed: boolean }[] = [];
  /** `answers` stat as the harness does for a handle it closed on its own: with nothing. */
  gone = false;
  /** Reads fail like a failing disk (not a replaced file). */
  failing = false;

  private constructor(readonly file: string) {}

  static async over(lines: readonly string[]): Promise<RealHarness> {
    const directory = await mkdtemp('ferretry-reader-lifecycle-');
    directories.push(directory);
    const file = join(directory, 'conversation.jsonl');
    await writeFile(file, `${lines.join('\n')}\n`);
    return new RealHarness(file);
  }

  readonly open = async (): Promise<HarnessTranscriptBytes | undefined> => {
    const real = handleOf(this.file);
    if (real === undefined) return undefined;
    const state = { closed: false };
    this.handles.push(state);
    return {
      ...real,
      read: async (offset, length) => {
        if (this.failing) throw Object.assign(new Error('input/output error'), { code: 'EIO' });
        return await real.read(offset, length);
      },
      stat: async () => (this.gone ? undefined : await real.stat()),
      close: async () => {
        state.closed = true;
        await real.close();
      },
    };
  };
}

const reader = (harness: RealHarness) =>
  registerReader({
    bytes: harness.open,
    transcripts: async () => ({
      harness: 'claude' as const,
      reader: {
        read: async (_ferret: FerretId, _after?: string) => [],
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
      redact: async text => text,
      batch: async work => work({ text: value => value, data: value => value }),
    },
    now: () => 0,
  });

const call = (query: Record<string, string> = {}) =>
  ({
    request: {
      query: new Map(Object.entries(query).map(([key, value]) => [key, [value]])),
      headers: { get: () => undefined },
      text: async () => '',
    } as unknown as ApiRequest,
    params: new Map(Object.entries({ ferretId: 'lead' })),
  }) as never;

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as { status: number; code?: string; message: string },
  );

const LOGS = 'GET /v1/ferrets/:ferretId/logs';
const MESSAGES = 'GET /v1/ferrets/:ferretId/messages';

describe('a ferret’s transcript handle, over a real file', () => {
  test('releasing a ferret closes its handle, and the next read opens a fresh one', async () => {
    const harness = await RealHarness.over([user(1, 'hello there')]);
    const reading = reader(harness);
    await reading.routes[LOGS](call());
    expect(harness.handles.filter(handle => !handle.closed)).toHaveLength(1);

    reading.release('lead');
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.handles.every(handle => handle.closed)).toBe(true);
    const again = (await reading.routes[LOGS](call())).body;
    expect(again).toContain('hello there');
    expect(harness.handles).toHaveLength(2);
    expect(harness.handles.filter(handle => !handle.closed)).toHaveLength(1);
    await reading.close();
  });

  test('a handle the harness already let go reads as a transcript this daemon cannot read, not as an empty one', async () => {
    const harness = await RealHarness.over([user(1, 'hello there')]);
    harness.gone = true;
    const reading = reader(harness);

    const refused = await refusal(reading.routes[LOGS](call()));

    expect(refused?.status).toBe(409);
    expect(refused?.code).toBe('transcript_unreadable');
    await reading.close();
  });

  test('messages over a disk that fails a read refuse the conversation with the reason, never an empty one', async () => {
    const harness = await RealHarness.over([user(1, 'hello there')]);
    harness.failing = true;
    const reading = reader(harness);

    const refused = await refusal(reading.routes[MESSAGES](call({ limit: '10' })));

    expect(refused?.status).toBe(409);
    expect(refused?.code).toBe('transcript_unreadable');
    expect(refused?.message).toContain('carries no physical record bytes');
    await reading.close();
  });

  test('messages over a damaged record keep the reason the read gave', async () => {
    const harness = await RealHarness.over([user(1, 'before'), '{"type":"user", broken', user(3, 'after')]);
    const reading = reader(harness);

    const refused = await refusal(reading.routes[MESSAGES](call({ limit: '10' })));

    expect(refused?.status).toBe(409);
    expect(refused?.code).toBe('transcript_unreadable');
    expect(refused?.message).toContain('could not read completely: transcript for lead');
    await reading.close();
  });
});
