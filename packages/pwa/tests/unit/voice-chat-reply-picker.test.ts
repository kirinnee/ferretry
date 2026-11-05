import { describe, expect, test } from 'bun:test';
import {
  NO_MESSAGE_WORDS,
  type PickerRow,
  pickQuestion,
  pickReply,
  QUESTION_KEY,
  QUESTION_ON_SCREEN_WORDS,
  SILENT_TURN_KEY,
} from '../../src/lib/voice-chat/reply-picker.ts';

const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);
const row = (
  id: string,
  kind: string,
  text: string,
  secondsAfter?: number,
  extra: Partial<PickerRow> = {},
): PickerRow => ({
  id,
  kind,
  text,
  ...(secondsAfter === undefined ? {} : { at: T0 + secondsAfter * 1000 }),
  ...extra,
});

describe('pickReply: last message of the turn', () => {
  test('reads only the LAST assistant text of the turn', () => {
    const rows = [
      row('u1', 'user', 'fix the login', 0),
      row('a1', 'assistant', 'Let me look at the code.', 2),
      row('t1', 'tool', 'ran grep', 3),
      row('a2', 'assistant', 'Fixed. All tests pass.', 9),
    ];
    expect(pickReply(rows, T0 + 1000)).toEqual({ key: 'a2', markdown: 'Fixed. All tests pass.', reason: 'reply' });
  });

  test('a turn that wrote no text says "Done. No message." and never falls back to the previous turn', () => {
    const rows = [
      row('u0', 'user', 'first', -100),
      row('a0', 'assistant', 'An answer to the FIRST message.', -90),
      row('u1', 'user', 'now run it', 0),
      row('t1', 'tool', 'ran the thing', 5),
    ];
    const pick = pickReply(rows, T0 + 1000);
    expect(pick).toEqual({ key: SILENT_TURN_KEY, markdown: NO_MESSAGE_WORDS, reason: 'no-message' });
    expect(NO_MESSAGE_WORDS).toBe('Done. No message.');
  });

  test('never reads other ferrets, agenda or system rows, notices, tools, sent messages or Pack commands', () => {
    const rows = [
      row('u1', 'user', 'go', 0),
      row('a1', 'assistant', 'My real answer.', 2),
      row('p1', 'user', 'A message from another ferret', 3, { peer: { from: 'dev' } }),
      row('s1', 'system', 'A background task finished', 4),
      row('n1', 'notice', 'Daemon bookkeeping', 5),
      row('c1', 'command', '/model opus', 6),
      row('l1', 'ledger', 'send attempt', 7),
      row('x1', 'assistant', 'a message this ferret SENT to a peer', 8, { sent: { to: 'dev' } }),
      row('k1', 'assistant', 'a Pack command', 9, { pack: { command: 'new' } }),
      row('e1', 'assistant', '   ', 10),
    ];
    expect(pickReply(rows, T0)).toMatchObject({ key: 'a1', markdown: 'My real answer.' });
  });

  test('a peer message in the middle of the turn is never read, and only what follows it is picked', () => {
    const rows = [
      row('u1', 'user', 'go', 0),
      row('a1', 'assistant', 'Working on it.', 2),
      row('p1', 'user', 'ping from another ferret', 3, { peer: { from: 'dev' } }),
      row('a2', 'assistant', 'Done.', 4),
    ];
    expect(pickReply(rows, T0).markdown).toBe('Done.');
  });

  test('a message sent after the turn began (a queued follow-up) is not the boundary', () => {
    const rows = [
      row('u1', 'user', 'go', 0),
      row('a1', 'assistant', 'First part.', 3),
      row('u2', 'user', 'also do this', 60),
      row('a2', 'assistant', 'Second part.', 70),
    ];
    expect(pickReply(rows, T0 + 1000).key).toBe('a2');
  });

  test('a clock a little behind still counts a reply as part of the turn', () => {
    const rows = [row('u1', 'user', 'go', 0), row('a1', 'assistant', 'Quick reply.', -3)];
    expect(pickReply(rows, T0 + 1000)).toMatchObject({ key: 'a1' });
  });

  test('a reply written long before the turn is not part of it', () => {
    const rows = [row('a0', 'assistant', 'An old message with no user row.', -600)];
    expect(pickReply(rows, T0).reason).toBe('no-message');
  });

  test('rows with no time still count; an unknown start (old daemon) reads after the last user row', () => {
    const rows = [row('u1', 'user', 'go'), row('a1', 'assistant', 'Untimed reply.')];
    expect(pickReply(rows, T0)).toMatchObject({ key: 'a1' });
    const old = [
      row('a0', 'assistant', 'Before.', -50),
      row('u1', 'user', 'go', 0),
      row('a1', 'assistant', 'After.', 5),
    ];
    expect(pickReply(old, null)).toMatchObject({ key: 'a1', markdown: 'After.' });
  });
});

describe('pickReply: every message', () => {
  test('joins every assistant text of the turn, in order, under the last row', () => {
    const rows = [
      row('u1', 'user', 'go', 0),
      row('a1', 'assistant', 'Let me look.', 2),
      row('t1', 'tool', 'grep', 3),
      row('a2', 'assistant', 'Found it.\n', 4),
    ];
    expect(pickReply(rows, T0, 'every')).toEqual({ key: 'a2', markdown: 'Let me look.\n\nFound it.', reason: 'reply' });
  });

  test('a silent turn is still "Done. No message."', () => {
    expect(pickReply([row('u1', 'user', 'go', 0)], T0, 'every').reason).toBe('no-message');
  });
});

describe('pickReply is total', () => {
  test('survives hostile input without throwing', () => {
    expect(pickReply([], null).reason).toBe('no-message');
    expect(pickReply(undefined as unknown as PickerRow[], T0).reason).toBe('no-message');
    const odd = [{ id: 'a', kind: 'assistant', text: 5 as unknown as string }, row('ok', 'assistant', 'fine', 1)];
    expect(pickReply(odd, null).key).toBe('ok');
    expect(pickReply([row('a', 'assistant', 'x', 1)], Number.NaN).reason).toBe('reply');
  });
});

describe('pickQuestion: read, never answered by voice', () => {
  test('reads the question and numbers its options', () => {
    const pick = pickQuestion({
      questions: [{ question: 'Which database should I use', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
    });
    expect(pick.key).toBe(QUESTION_KEY);
    expect(pick.reason).toBe('question');
    expect(pick.markdown).toBe('The ferret asks. Which database should I use. Options: one, Postgres; two, SQLite.');
  });

  test('keeps a question mark, says when more than one can be picked, and counts options past eight', () => {
    const labels = Array.from({ length: 10 }, (_, index) => ({ label: `Choice ${index + 1}` }));
    const pick = pickQuestion({ questions: [{ question: 'Pick some?', options: labels, multiSelect: true }] });
    expect(pick.markdown).toContain('Pick some? You can pick more than one. Options: one, Choice 1;');
    expect(pick.markdown).toContain('eight, Choice 8. And 2 more on screen.');
    expect(pick.markdown).not.toContain('Choice 9');
  });

  test('several questions are read one after another; empty labels are skipped', () => {
    const pick = pickQuestion({
      questions: [{ question: 'First?', options: [{ label: '  ' }, { label: 'A' }] }, { question: 'Second' }],
    });
    expect(pick.markdown).toBe('The ferret asks. First? Options: one, A. Second.');
  });

  test('with nothing readable it says where to look', () => {
    for (const none of [null, undefined, {}, { questions: [] }, { questions: [{ question: ' ' }] }]) {
      expect(pickQuestion(none)).toEqual({ key: QUESTION_KEY, markdown: QUESTION_ON_SCREEN_WORDS, reason: 'question' });
    }
    expect(pickQuestion({ questions: 'nope' } as never).reason).toBe('question');
  });
});
