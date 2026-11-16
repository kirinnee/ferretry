import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Instant } from '@ferretry/std';
import { parseEntries } from '../../../daemon/lib/harness/transcript.ts';

/**
 * The tool identity a transcript entry carries (finding 1 of the structured-questions review). Conversation's question
 * watch retires a hook file whose call or result the transcript names, and it can only match an id the reader kept: the
 * ids are fields of Claude's content blocks (`tool_use.id`, `tool_result.tool_use_id`), not part of any message's text.
 *
 * The expected entries are the fixture the kernel's question-detect test feeds the REAL watch (a plugin test may not
 * import another plugin, so the two meet in this file): a change to what the reader parses fails here first.
 */
const utf8 = new TextEncoder();
const FIXTURES = join(import.meta.dir, '../../fixtures/transcript-question');
const jsonl = readFileSync(join(FIXTURES, 'ask-user-question-answered.jsonl'), 'utf8');
const expected = JSON.parse(readFileSync(join(FIXTURES, 'ask-user-question-answered.entries.json'), 'utf8'));

test('an AskUserQuestion call and its result are named by id, and the prose after them is not a tool entry', () => {
  expect(parseEntries(utf8.encode(jsonl))).toEqual(expected);
});

test('a record with no tool block carries no identity', () => {
  const [plain] = parseEntries(
    utf8.encode(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a',
        timestamp: '2026-10-30T04:36:05.000Z',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ),
  );
  expect(plain).toEqual({ id: 'a', at: '2026-10-30T04:36:05.000Z' as Instant, role: 'assistant', text: 'hello' });
});

test('a tool result with prose still names its call', () => {
  const [mixed] = parseEntries(
    utf8.encode(
      JSON.stringify({
        type: 'user',
        uuid: 'u',
        timestamp: '2026-10-30T04:36:05.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' },
            { type: 'text', text: 'and a note' },
          ],
        },
      }),
    ),
  );
  expect(mixed?.text).toBe('and a note');
  expect(mixed?.tools).toEqual({ results: ['toolu_x'] });
  expect(mixed?.data).toBeUndefined();
});
