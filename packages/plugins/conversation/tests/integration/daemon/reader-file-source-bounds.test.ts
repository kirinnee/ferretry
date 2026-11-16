import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { appendFile, mkdtemp, newSource, rm, writeFile } from '../../support/disk-files.ts';
import { ClaudeTranscriptParser } from '../../../daemon/reader/lib/transcript/claude.ts';
import type { TranscriptBatch, TranscriptWindow } from '../../../daemon/reader/lib/transcript/types.ts';

/**
 * Where a window over a REAL file on disk is placed and where it stops: a byte offset at or past the end of the
 * file, and an `end` that falls inside the file. The file is read through the production bytes runtime by real descriptors.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const directory = await mkdtemp('ferretry-transcript-bounds-');
  directories.push(directory);
  return directory;
}

function user(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: `u-${text}`,
    message: { role: 'user', content: text },
    timestamp: '2026-10-20T12:00:00.000Z',
  })}\n`;
}

const texts = (batches: readonly TranscriptBatch[]): string[] =>
  batches.flatMap(batch => batch.observedInputs.map(input => input.text.trim()));

async function drain(window: TranscriptWindow): Promise<TranscriptBatch[]> {
  const batches: TranscriptBatch[] = [];
  for (;;) {
    const { batch, more } = await window.next();
    if (batch !== undefined) batches.push(batch);
    if (!more) return batches;
  }
}

describe('a window placed by byte offset over a file on disk', () => {
  it('is placed at the end of the file when the offset is at or past it, and reads only what is appended after', async () => {
    const file = join(await folder(), 'conversation.jsonl');
    const written = `${user('one')}${user('two')}`;
    await writeFile(file, written);
    const size = new TextEncoder().encode(written).byteLength;
    const window = newSource(new ClaudeTranscriptParser()).window(file, {
      sessionId: 's',
      start: { at: 'offset', byteOffset: size + 4_096 },
    });

    const placed = await drain(window);
    await appendFile(file, user('three'));
    const appended = await drain(window);

    expect(texts(placed)).toEqual([]);
    expect(placed[0]?.cursor.byteOffset).toBe(size);
    expect(texts(appended)).toEqual(['three']);
  });

  it('stops before its end, leaving the records past it unread, and says it has no more', async () => {
    const file = join(await folder(), 'page.jsonl');
    const first = `${user('one')}${user('two')}`;
    await writeFile(file, `${first}${user('three')}${user('four')}`);
    const end = new TextEncoder().encode(first).byteLength;
    const window = newSource(new ClaudeTranscriptParser()).window(file, {
      sessionId: 's',
      start: { at: 'beginning' },
      end,
    });

    const page = await window.next();
    const after = await window.next();

    expect(texts(page.batch === undefined ? [] : [page.batch])).toEqual(['one', 'two']);
    expect(page.batch?.cursor.byteOffset).toBe(end);
    expect(page.more).toBe(false);
    expect(after.more).toBe(false);
    expect(texts(after.batch === undefined ? [] : [after.batch])).toEqual([]);
  });
});
