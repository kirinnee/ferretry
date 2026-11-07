import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Instant } from '@ferretry/std';
import { TranscriptReadError, TranscriptReadService, type TranscriptReadRedactor } from '../../../daemon/reader/lib/reads.ts';
import type { PortableConversationRow } from '../../../daemon/reader/lib/session/digest.ts';
import type { SessionTranscriptMessageTokenContext } from '../../../daemon/reader/lib/session/message-token.ts';
import type { TranscriptEvent } from '../../../daemon/reader/lib/transcript/types.ts';

/**
 * R265, G41: everything the transcript reads answer is scrubbed, and a vault that cannot be opened refuses the read
 * instead of serving unscrubbed text. Each case holds a secret in a different place a read can carry text.
 */

const SECRET = 'sk-live-0123456789';
const INSTANT = '2026-02-01T09:08:07.000Z';
const CODEC = {
  tag: async (input: Uint8Array) => new Uint8Array(createHmac('sha256', 'k').update(input).digest()),
  matches: async () => true,
};
const CONTEXT: SessionTranscriptMessageTokenContext = {
  sessionId: 's1',
  incarnation: 'inc',
  provenance: {
    v: 1,
    home: '/h',
    identity: 'minted',
    harnessSessionId: 'h1',
    file: '/h/one.jsonl',
    resolvedAt: INSTANT,
  },
};

const mask = (text: string): string => text.split(SECRET).join('[redacted:TOKEN]');
const masking = (damaged = false): TranscriptReadRedactor => ({
  redact: async text => {
    if (damaged) throw new Error('the vault could not be opened');
    return mask(text);
  },
  batch: async work => {
    if (damaged) throw new Error('the vault could not be opened');
    return work({ text: mask, data: value => JSON.parse(mask(JSON.stringify(value))) as unknown });
  },
});

const message = (text: string): TranscriptEvent =>
  ({ kind: 'message', harness: 'claude', role: 'assistant', timestamp: INSTANT, text }) as TranscriptEvent;
const row = (text: string, byteOffset: number): PortableConversationRow => ({
  point: { v: 1, byteOffset, blockIndex: 0 },
  role: 'assistant',
  text,
  timestamp: INSTANT as Instant,
  rawPrefix: new Uint8Array(32).fill(byteOffset),
});

const service = (redactor: TranscriptReadRedactor): TranscriptReadService =>
  new TranscriptReadService(
    { tail: async () => ({ kind: 'read', events: [message(`I ran it with ${SECRET}`)] }) },
    { read: async () => ({ kind: 'read', context: CONTEXT, rows: [row(`ran with ${SECRET}`, 10), row('clean', 20)] }) },
    CODEC,
    redactor,
    { page: async () => ({ kind: 'read', events: [message(`an older ${SECRET}`)], start: 0, file: 'file-token' }) },
    {
      search: async () => ({
        kind: 'read',
        events: [message(`found ${SECRET} here`)],
        truncated: false,
        file: 'file-token',
      }),
    },
  );

describe('the transcript reads are scrubbed', () => {
  test('R265 logs carry no secret', async () => {
    const text = await service(masking()).logs('s1', undefined);
    expect(text).toContain('[redacted:TOKEN]');
    expect(text).not.toContain(SECRET);
  });

  test('R265 a log page carries no secret and keeps where it sits', async () => {
    const page = await service(masking()).logPage('s1', {});
    expect(JSON.stringify(page)).not.toContain(SECRET);
    expect(page).toMatchObject({ v: 1, ferret: 's1', start: 0, file: 'file-token' });
  });

  test('R265 a search snippet is cut from masked text, so a match inside a secret finds nothing to quote', async () => {
    const answer = await service(masking()).logSearch('s1', { q: 'found' });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer.matches).toHaveLength(1);
  });

  test('G41 message rows are scrubbed and bound over the raw text, not the scrubbed one', async () => {
    const page = await service(masking()).messages('s1', undefined, undefined);
    expect(JSON.stringify(page)).not.toContain(SECRET);
    expect(page.messages.map(each => each.text)).toEqual(['ran with [redacted:TOKEN]', 'clean']);
    expect(page.messages.every(each => each.selectionBinding.length > 0)).toBe(true);
  });

  test('a vault that cannot be opened refuses every read rather than serving raw text', async () => {
    const damaged = service(masking(true));
    for (const read of [
      () => damaged.logs('s1', undefined),
      () => damaged.logPage('s1', {}),
      () => damaged.logSearch('s1', { q: 'found' }),
      () => damaged.messages('s1', undefined, undefined),
    ]) {
      const error = await read().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TranscriptReadError);
    }
  });
});
