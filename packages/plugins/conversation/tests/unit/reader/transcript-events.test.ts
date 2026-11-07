import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  TranscriptReadError,
  TranscriptReadService,
  type TranscriptReadRedactor,
} from '../../../daemon/reader/lib/reads.ts';
import { TranscriptEventTailSchema as ContractTail } from '../../../contract/index.ts';
import type { TranscriptEvent } from '../../../daemon/reader/lib/transcript/types.ts';

/**
 * The tail read that carries a turn's tool calls (the additive read Board's PR-from-transcript linking and its turn and
 * gate checks need). A tool call's input and a tool result's content are where a secret most likely sits, so every one of
 * them is scrubbed through the same read-scoped redaction as the messages.
 */

const SECRET = 'ghp_0123456789abcdef';
const INSTANT = '2026-02-01T09:08:07.000Z';
const CODEC = {
  tag: async (input: Uint8Array) => new Uint8Array(createHmac('sha256', 'k').update(input).digest()),
  matches: async () => true,
};
const mask = (text: string): string => text.split(SECRET).join('[redacted:GH_TOKEN]');
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

const stamped = { harness: 'claude', timestamp: INSTANT } as const;
const events: readonly TranscriptEvent[] = [
  { ...stamped, kind: 'message', role: 'user', text: 'open the PR' },
  { ...stamped, kind: 'message', role: 'user', text: 'a background task finished', inputSource: 'harness' },
  { ...stamped, kind: 'reasoning', role: 'assistant', text: 'thinking', format: 'thinking' },
  {
    ...stamped,
    kind: 'tool-call',
    role: 'assistant',
    call: {
      id: 'toolu_1',
      name: 'Bash',
      input: { command: `GH_TOKEN=${SECRET} gh pr create --fill`, nested: [SECRET] },
    },
  },
  {
    ...stamped,
    kind: 'tool-result',
    role: 'tool',
    result: {
      callId: 'toolu_1',
      content: [{ type: 'text', text: `https://github.com/o/r/pull/7 (${SECRET})` }],
      text: `https://github.com/o/r/pull/7 (${SECRET})`,
      isError: false,
    },
  },
  { kind: 'message', harness: 'claude', role: 'assistant', text: 'opened it' },
] as unknown as readonly TranscriptEvent[];

const service = (redactor: TranscriptReadRedactor, tail?: { kind: 'unresolved' } | { kind: 'unreadable' }) =>
  new TranscriptReadService(
    {
      tail: async (_ferret, limit) => (tail === undefined ? { kind: 'read', events: events.slice(-limit) } : tail),
    },
    { read: async () => ({ kind: 'unreadable' }) },
    CODEC,
    redactor,
  );

describe('the transcript tail carries the tool calls of a turn', () => {
  test('messages, tool calls and their results come in the order the harness wrote them; reasoning does not', async () => {
    const tail = await service(masking()).transcriptEvents('s1', undefined);
    expect(tail.events.map(event => event.kind)).toEqual(['message', 'message', 'tool-call', 'tool-result', 'message']);
    expect(tail.events[2]).toMatchObject({ kind: 'tool-call', call: { id: 'toolu_1', name: 'Bash' } });
    expect(tail.events[3]).toMatchObject({ kind: 'tool-result', result: { callId: 'toolu_1', isError: false } });
  });

  test('a message the harness wrote into the user channel says so, so it is never taken for the owner', async () => {
    const tail = await service(masking()).transcriptEvents('s1', undefined);
    expect(tail.events[1]).toMatchObject({ kind: 'message', role: 'user', inputSource: 'harness' });
    expect(tail.events[0]).not.toHaveProperty('inputSource');
  });

  test('G164 a call’s input and a result’s content carry no secret, and keep their shape', async () => {
    const tail = await service(masking()).transcriptEvents('s1', undefined);
    expect(JSON.stringify(tail)).not.toContain(SECRET);
    expect(tail.events[2]).toMatchObject({
      call: { input: { command: 'GH_TOKEN=[redacted:GH_TOKEN] gh pr create --fill', nested: ['[redacted:GH_TOKEN]'] } },
    });
    expect(tail.events[3]).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'https://github.com/o/r/pull/7 ([redacted:GH_TOKEN])' }],
        text: 'https://github.com/o/r/pull/7 ([redacted:GH_TOKEN])',
      },
    });
  });

  test('the tail is the contract’s own schema', async () => {
    const tail = await service(masking()).transcriptEvents('s1', undefined);
    expect(ContractTail.parse(tail)).toEqual(tail);
  });

  test('a limit asks the harness reader for that many of the newest events', async () => {
    const tail = await service(masking()).transcriptEvents('s1', 2);
    expect(tail.events.map(event => event.kind)).toEqual(['tool-result', 'message']);
  });

  test('a transcript nobody proved is the ferret’s refuses, as an empty tail would read as "it did nothing"', async () => {
    const error = await service(masking(), { kind: 'unresolved' })
      .transcriptEvents('s1', undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TranscriptReadError);
    expect(error).toMatchObject({ failure: 'no_transcript' });
    const unreadable = await service(masking(), { kind: 'unreadable' })
      .transcriptEvents('s1', undefined)
      .catch((caught: unknown) => caught);
    expect(unreadable).toMatchObject({ failure: 'transcript_unreadable' });
  });

  test('a vault that cannot be opened refuses the read rather than serving raw tool input', async () => {
    const error = await service(masking(true))
      .transcriptEvents('s1', undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TranscriptReadError);
  });

  test('a limit that is not a positive integer inside the bound is refused', async () => {
    for (const bad of [0, -1, 1.5, 2_001]) {
      const error = await service(masking())
        .transcriptEvents('s1', bad)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ failure: 'invalid_query' });
    }
  });
});

describe('the log tail the Warden fingerprints (transcriptLog: today’s operatorReads.logs)', () => {
  test('every event kind is rendered — reasoning included, which the event tail leaves out — and masked', async () => {
    const log = await service(masking()).logs('s1', 20);
    const tail = await service(masking()).transcriptEvents('s1', 20);
    expect(log).toContain('thinking');
    expect(JSON.stringify(tail)).not.toContain('thinking');
    expect(log).toContain('open the PR');
    expect(log).toContain('[redacted:GH_TOKEN]');
    expect(log).not.toContain(SECRET);
  });
});
