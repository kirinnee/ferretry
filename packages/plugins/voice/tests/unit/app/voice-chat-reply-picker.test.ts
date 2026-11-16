import { describe, expect, test } from 'bun:test';
import {
  NO_MESSAGE_WORDS,
  needsInputOf,
  type PickerRow,
  pickLatestReply,
  pickQuestion,
  pickReply,
  pickReplyToSend,
  QUESTION_KEY,
  QUESTION_ON_SCREEN_WORDS,
  SILENT_TURN_KEY,
} from '../../../app/lib/voice-chat/reply-picker.ts';

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

describe('pickReply: the turn boundary is the initiating record', () => {
  test('REGRESSION (round 1, #7): a follow-up within five seconds does not replace the turn boundary', () => {
    const rows = [
      row('u1', 'user', 'fix it', 0),
      row('a1', 'assistant', 'The fix is in.', 2),
      row('u2', 'user', 'thanks, one more thing', 3),
    ];
    expect(pickReply(rows, T0)).toEqual({ key: 'a1', markdown: 'The fix is in.', reason: 'reply' });
  });

  test('the harness clock a little ahead: the row that began the turn, dated just after it, still begins it', () => {
    const rows = [
      row('u0', 'user', 'earlier', -600),
      row('a0', 'assistant', 'Earlier reply.', -590),
      row('u1', 'user', 'now', 2),
      row('a1', 'assistant', 'Reply to now.', 6),
    ];
    expect(pickReply(rows, T0)).toMatchObject({ key: 'a1' });
  });

  test('a row dated after the slack, or after the agent already answered, never begins the turn', () => {
    const late = [row('u1', 'user', 'go', 0), row('a1', 'assistant', 'Reply.', 2), row('u2', 'user', 'later', 20)];
    expect(pickReply(late, T0).key).toBe('a1');
    const answered = [
      row('u0', 'user', 'earlier', -600),
      row('a0', 'assistant', 'Answer after the start.', 1),
      row('u1', 'user', 'skewed?', 3),
      row('a1', 'assistant', 'Second.', 4),
    ];
    expect(pickReply(answered, T0).key).toBe('a1');
    expect(pickReply(answered, T0, 'every').markdown).toBe('Answer after the start.\n\nSecond.');
  });
});

describe('pickReply: a send names its own boundary', () => {
  test('the first row of the person not among the rows held at the press begins the turn, whatever the clocks say', () => {
    const rows = [
      row('u0', 'user', 'earlier', 0),
      row('a0', 'assistant', 'Earlier reply.', 1),
      // The browser's clock is far behind the harness's: every time below is nonsense to the picker.
      row('u1', 'user', 'new message', -900),
      row('a1', 'assistant', 'Reply to it.', -899),
      row('u2', 'user', 'follow-up', -898),
    ];
    const pick = pickReply(rows, { startedAt: T0 + 99_000, knownIds: ['u0', 'a0'] });
    expect(pick).toEqual({ key: 'a1', markdown: 'Reply to it.', reason: 'reply' });
  });

  test("before the person's own row shows, the turn begins after everything already held", () => {
    const rows = [row('u0', 'user', 'earlier', 0), row('a0', 'assistant', 'Earlier reply.', 1)];
    expect(pickReply(rows, { startedAt: null, knownIds: ['u0', 'a0'] }).reason).toBe('no-message');
    expect(pickReply(rows, { startedAt: null, knownIds: [] })).toMatchObject({ key: 'a0' });
  });

  test("another ferret's message is not the person's row", () => {
    const rows = [
      row('u0', 'user', 'earlier', 0),
      row('p1', 'user', 'ping', 1, { peer: { from: 'dev' } }),
      row('u1', 'user', 'mine', 2),
      row('a1', 'assistant', 'Done.', 3),
    ];
    expect(pickReply(rows, { startedAt: null, knownIds: ['u0'] }).key).toBe('a1');
  });
});

describe('needsInputOf: every needs-input prompt becomes read-only question data', () => {
  const options = [{ label: 'Yes' }, { label: 'No, and tell it why' }];

  test('a permission prompt is read with its tool and options, not the generic fallback', () => {
    const asked = needsInputOf({
      permissionRequest: { tool: 'Bash', question: 'Do you want to proceed?', options },
      turnPrompt: 'Waiting for approval',
    });
    expect(pickQuestion(asked)).toEqual({
      key: QUESTION_KEY,
      markdown: 'The ferret asks. Bash: Do you want to proceed? Options: one, Yes; two, No, and tell it why.',
      reason: 'question',
    });
  });

  test('a permission prompt without a tool name reads just the question', () => {
    expect(needsInputOf({ permissionRequest: { question: 'Proceed?' } })).toEqual({
      questions: [{ question: 'Proceed?', options: [] }],
    });
  });

  test('a harness dialog is read by its title and rows', () => {
    const asked = needsInputOf({ harnessDialog: { title: 'Review hooks', options }, turnPrompt: 'x' });
    expect(pickQuestion(asked).markdown).toBe(
      'The ferret asks. Review hooks. Options: one, Yes; two, No, and tell it why.',
    );
    expect(pickQuestion(needsInputOf({ harnessDialog: { title: 'Sign in' } })).markdown).toBe(
      'The ferret asks. Sign in.',
    );
  });

  test("the agent's own question comes next, then the daemon's one-line reason", () => {
    const question = { questions: [{ question: 'Which one?', options: [{ label: 'A' }] }] };
    expect(needsInputOf({ question, turnPrompt: 'Waiting' })).toBe(question);
    expect(pickQuestion(needsInputOf({ turnPrompt: '  Needs your sign-off  ' })).markdown).toBe(
      'The ferret asks. Needs your sign-off.',
    );
  });

  test('nothing to read is null, and an unreadable prompt falls back to "on screen"', () => {
    expect(needsInputOf({})).toBeNull();
    expect(needsInputOf({ question: null, permissionRequest: null, harnessDialog: null, turnPrompt: '  ' })).toBeNull();
    expect(
      pickQuestion(needsInputOf({ permissionRequest: { question: '   ' }, harnessDialog: { title: '' } })).markdown,
    ).toBe(QUESTION_ON_SCREEN_WORDS);
  });
});

describe('pickLatestReply: the last assistant text after the last row of the person’s', () => {
  const held = [
    row('u1', 'user', 'first', 1),
    row('a1', 'assistant', 'first reply', 2),
    row('a2', 'assistant', 'second thought', 3),
  ];

  test('reads the last text after the last user row', () => {
    expect(pickLatestReply(held)).toEqual({ key: 'a2', markdown: 'second thought', reason: 'reply' });
  });

  test('R4 #1: a silent turn says "Done. No message." however many older rows were hydrated before it', () => {
    const rows = [
      ...held,
      row('u0', 'user', 'older, hydrated late', 0),
      row('a0', 'assistant', 'Historical answer.', 0),
      row('u2', 'user', 'second', 5),
    ];
    expect(pickLatestReply(rows)).toEqual({ key: SILENT_TURN_KEY, markdown: NO_MESSAGE_WORDS, reason: 'no-message' });
  });

  test('every message of the turn, when chosen — and only that turn’s', () => {
    const rows = [
      ...held,
      row('u2', 'user', 'second', 5),
      row('a3', 'assistant', ' one ', 6),
      row('a4', 'assistant', 'two', 7),
    ];
    expect(pickLatestReply(rows, 'every')).toEqual({ key: 'a4', markdown: 'one\n\ntwo', reason: 'reply' });
  });

  test('a ferret’s message (peer) is not the person’s row, and not read; no user row at all means the whole conversation', () => {
    const rows = [
      row('a1', 'assistant', 'hello', 1),
      row('p1', 'user', 'from a ferret', 2, { peer: { from: 'x' } }),
      row('a2', 'assistant', 'bye', 3),
    ];
    expect(pickLatestReply(rows).markdown).toBe('bye');
    expect(pickLatestReply([]).reason).toBe('no-message');
    expect(pickLatestReply('nope' as unknown as readonly PickerRow[]).reason).toBe('no-message');
  });
});

describe('pickReplyToSend: the reply to ONE send, with evidence the send’s own row is in the rows', () => {
  const send = { sendId: 's2', message: 'and this', acceptedAt: T0 + 30_000 };
  const old = [row('u1', 'user', 'fix it', 0), row('a1', 'assistant', 'Old answer.', 5)];

  test('null while the send’s own row is not there: the previous answer is never the reply', () => {
    expect(pickReplyToSend(old, send)).toBeNull();
    expect(pickReplyToSend([], send)).toBeNull();
    expect(pickReplyToSend('nope' as unknown as readonly PickerRow[], send)).toBeNull();
  });

  test('by identity: the row the transcript joined to THIS send; another send’s row, same words, is not it', () => {
    const rows = [
      ...old,
      row('u2', 'user', 'and this', 31, { send: { sendId: 's2' } }),
      row('a2', 'assistant', 'New answer.', 40),
    ];
    expect(pickReplyToSend(rows, send)).toEqual({ key: 'a2', markdown: 'New answer.', reason: 'reply' });
    const other = [row('u2', 'user', 'and this', 31, { send: { sendId: 's1' } }), row('a2', 'assistant', 'Old.', 40)];
    expect(pickReplyToSend(other, send)).toBeNull();
    // Identity needs neither the words nor a date.
    const bare = { sendId: 's2', acceptedAt: null };
    expect(pickReplyToSend([row('u2', 'user', 'anything', undefined, { send: { sendId: 's2' } })], bare)?.reason).toBe(
      'no-message',
    );
  });

  test('by words and time when the row is not joined: the same words, dated no earlier than the daemon accepted the send', () => {
    const rows = [...old, row('u2', 'user', '  and\n this ', 31), row('a2', 'assistant', 'New answer.', 40)];
    expect(pickReplyToSend(rows, send)?.markdown).toBe('New answer.');
    // The very moment of acceptance counts…
    expect(pickReplyToSend([row('u2', 'user', 'and this', 30), row('a2', 'assistant', 'A.', 40)], send)?.key).toBe(
      'a2',
    );
    // …an older identical row (a message sent before, even a moment before) is not this send’s.
    expect(pickReplyToSend([row('u0', 'user', 'and this', 29), row('a0', 'assistant', 'Old.', 40)], send)).toBeNull();
    expect(pickReplyToSend([row('u0', 'user', 'and this', 5), row('a0', 'assistant', 'Old.', 6)], send)).toBeNull();
  });

  test('words alone are not evidence: different words, no date, no message, no acceptance', () => {
    const answer = row('a2', 'assistant', 'Answer.', 40);
    expect(pickReplyToSend([row('u2', 'user', 'something else', 31), answer], send)).toBeNull();
    expect(pickReplyToSend([row('u2', 'user', 'and this'), answer], send)).toBeNull();
    expect(pickReplyToSend([row('u2', 'user', 'and this', 31), answer], { sendId: 's2', acceptedAt: T0 })).toBeNull();
    expect(
      pickReplyToSend([row('u2', 'user', 'and this', 31), answer], { sendId: 's2', message: '  ', acceptedAt: T0 }),
    ).toBeNull();
    expect(pickReplyToSend([row('u2', 'user', 'and this', 31), answer], { sendId: 's2', acceptedAt: T0 })).toBeNull();
    expect(pickReplyToSend([row('u2', 'user', 'and this', 31), answer], { ...send, acceptedAt: null })).toBeNull();
    // A ferret’s message with the same words, and an assistant row, are never the person’s row.
    const peer = row('p', 'user', 'and this', 31, { peer: { from: 'x' } });
    expect(pickReplyToSend([peer, answer], send)).toBeNull();
    expect(pickReplyToSend([row('x', 'assistant', 'and this', 31), answer], send)).toBeNull();
  });

  test('only what comes AFTER the send’s own row and before the next row of the person’s; the last own row wins', () => {
    const rows = [
      row('u2', 'user', 'and this', 31),
      row('a2', 'assistant', 'First thought.', 33),
      row('a3', 'assistant', 'The answer.', 40),
      row('u3', 'user', 'and more', 41),
      row('a4', 'assistant', 'Reply to the next one.', 50),
    ];
    expect(pickReplyToSend(rows, send)).toEqual({ key: 'a3', markdown: 'The answer.', reason: 'reply' });
    expect(pickReplyToSend(rows, send, 'every')?.markdown).toBe('First thought.\n\nThe answer.');
    // A silent turn says so: its own row is there, nothing follows.
    expect(pickReplyToSend([row('u2', 'user', 'and this', 31), row('t', 'tool', 'ran', 32)], send)).toEqual({
      key: SILENT_TURN_KEY,
      markdown: NO_MESSAGE_WORDS,
      reason: 'no-message',
    });
    // Sent twice, the later row (the send’s own, within the window) is the one answered.
    const twice = [
      row('u2', 'user', 'and this', 31),
      row('a2', 'assistant', 'Too early.', 33),
      row('u2b', 'user', 'and this', 35),
    ];
    expect(pickReplyToSend(twice, send)?.reason).toBe('no-message');
  });
});
