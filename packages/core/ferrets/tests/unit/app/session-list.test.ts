import { describe, expect, test } from 'bun:test';
import {
  ConditionalSessionList,
  type SessionListAnswer,
  UntaggedSessionListError,
} from '../../../app/lib/session-list.ts';

interface Row {
  readonly id: string;
  readonly name: string;
}

const parse = (body: unknown): readonly Row[] => body as Row[];

/** A scripted daemon: each read takes the next answer, and every header set it was sent is kept. */
const scripted = (answers: readonly SessionListAnswer[]) => {
  const sent: Readonly<Record<string, string>>[] = [];
  let at = 0;
  const reader = new ConditionalSessionList<Row>(async headers => {
    sent.push(headers);
    const answer = answers[at];
    at += 1;
    if (answer === undefined) throw new Error('no answer scripted');
    return answer;
  }, parse);
  return { reader, sent };
};

describe('the ferret list, read conditionally', () => {
  test('R502 keeps one last list per connection and answers a 304 with it', async () => {
    const list = [{ id: 's-1', name: 'otter' }];
    const { reader, sent } = scripted([
      { status: 200, etag: '"a"', body: list },
      { status: 304, etag: '"a"' },
    ]);

    const first = await reader.read();
    const second = await reader.read();

    expect(sent).toEqual([{}, { 'if-none-match': '"a"' }]);
    expect(second).toEqual([{ id: 's-1', name: 'otter' }]);
    expect(second).toBe(first);
  });

  test('R502 the held list cannot be changed through what a caller was given', async () => {
    const { reader } = scripted([{ status: 200, etag: '"a"', body: [{ id: 's-1', name: 'otter' }] }]);

    const rows = await reader.read();

    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(() => {
      (rows[0] as { name: string }).name = 'weasel';
    }).toThrow();
  });

  test('R502 a changed list replaces the held one and its tag', async () => {
    const { reader, sent } = scripted([
      { status: 200, etag: '"a"', body: [{ id: 's-1', name: 'otter' }] },
      { status: 200, etag: '"b"', body: [{ id: 's-1', name: 'stoat' }] },
      { status: 304, etag: '"b"' },
    ]);

    await reader.read();
    await reader.read();
    const held = await reader.read();

    expect(sent.at(-1)).toEqual({ 'if-none-match': '"b"' });
    expect(held).toEqual([{ id: 's-1', name: 'stoat' }]);
  });

  test('R502 an answer without an etag is refused, never read in full as an older daemon was', async () => {
    const { reader } = scripted([{ status: 200, etag: null, body: [] }]);

    await expect(reader.read()).rejects.toBeInstanceOf(UntaggedSessionListError);
  });
});
