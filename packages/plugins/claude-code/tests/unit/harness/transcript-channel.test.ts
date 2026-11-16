/** Ferretry's own MCP channel as the harness's entries read it: the words inside the wrapper, from the right records only. */
import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { parseEntry, parseTail } from '../../../daemon/lib/harness/transcript.ts';

const BANNER = '[message from :lead · send s-1]';
const TEXT = `${BANNER}\nPlease look at the failing test.`;
const WRAPPED = `<channel source="ferretry" send_id="s-1">\n${TEXT}\n</channel>`;
const OTHER = '<channel source="testchan" seq="1">\nPING\n</channel>';
const ORIGIN = { kind: 'channel', server: 'ferretry' };
const AT = '2026-11-16T06:05:05.818Z' as Instant;
const line = (value: unknown): string => JSON.stringify(value);

const user = (content: unknown, extra: object = {}) =>
  line({
    type: 'user',
    uuid: 'u1',
    timestamp: AT,
    message: { role: 'user', content },
    isMeta: true,
    origin: ORIGIN,
    ...extra,
  });
const drain = (prompt: unknown, origin: unknown = ORIGIN) =>
  line({
    type: 'attachment',
    uuid: 'a1',
    timestamp: AT,
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin, isMeta: true },
  });

describe('Ferretry channel entries', () => {
  test('an idle channel record is a user entry with the wrapper off', () => {
    expect(parseEntry(user(WRAPPED))).toMatchObject({ role: 'user', text: TEXT });
    expect(parseEntry(user([{ type: 'text', text: WRAPPED }]))).toMatchObject({ role: 'user', text: TEXT });
  });

  test('the send_id of the wrapper is kept in the entry’s data, on a user record, a drain and a queue line', () => {
    expect(parseEntry(user(WRAPPED))).toMatchObject({ text: TEXT, data: { channelSendId: 's-1' } });
    expect(parseEntry(drain(WRAPPED))).toMatchObject({ data: { proof: 'queued-prompt', channelSendId: 's-1' } });
    expect(
      parseEntry(line({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, content: WRAPPED })),
    ).toMatchObject({ text: TEXT, data: { proof: 'queue-operation', operation: 'enqueue', channelSendId: 's-1' } });
  });

  test('a wrapper that names no send, or whose value only contains the attribute, gives words and no send id', () => {
    const bare = '<channel source="ferretry">\nA\n</channel>';
    const tricky = '<channel source="ferretry" from="a send_id=" send_id="real">\nA\n</channel>';
    expect(parseEntry(user(bare))).toEqual({ id: 'u1', at: AT, role: 'user', text: 'A' });
    expect(parseEntry(user(tricky))).toMatchObject({ text: 'A', data: { channelSendId: 'real' } });
    expect(parseEntry(user(OTHER, { origin: { kind: 'channel', server: 'testchan' } }))).not.toHaveProperty('data');
  });

  test('another server’s record, and a wrapper a person typed, keep their wrapper', () => {
    expect(parseEntry(user(OTHER, { origin: { kind: 'channel', server: 'testchan' } }))?.text).toBe(OTHER);
    expect(parseEntry(user(WRAPPED, { origin: { kind: 'human' } }))?.text).toBe(WRAPPED);
    expect(parseEntry(user('<channel source="ferretry"> unclosed'))?.text).toBe('<channel source="ferretry"> unclosed');
  });

  test('the busy drain is a queued-prompt proof entry with the wrapper off', () => {
    expect(parseEntry(drain(WRAPPED))).toMatchObject({
      role: 'system',
      text: TEXT,
      data: { proof: 'queued-prompt' },
    });
    expect(parseEntry(drain([{ type: 'text', text: WRAPPED }]))?.text).toBe(TEXT);
    expect(parseEntry(drain(OTHER, { kind: 'channel', server: 'testchan' }))).toBeUndefined();
  });

  test('the enqueue, dequeue and remove lines carry the words, so the receipt matches the send', () => {
    for (const operation of ['enqueue', 'dequeue', 'remove']) {
      const entry = parseEntry(line({ type: 'queue-operation', operation, timestamp: AT, content: WRAPPED }));
      expect(entry).toMatchObject({ text: TEXT, data: { proof: 'queue-operation', operation } });
    }
    const other = parseEntry(line({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, content: OTHER }));
    expect(other?.text).toBe(OTHER);
  });

  test('a channel user record is a message in the tail, not a harness record; another server’s stays one', () => {
    const [ours] = parseTail(user(WRAPPED), false);
    const [theirs] = parseTail(user(OTHER, { origin: { kind: 'channel', server: 'testchan' } }), false);
    expect(ours).toEqual({ kind: 'message', role: 'user', at: AT });
    expect(theirs).toEqual({ kind: 'message', role: 'user', at: AT, inputSource: 'harness' });
  });
});
