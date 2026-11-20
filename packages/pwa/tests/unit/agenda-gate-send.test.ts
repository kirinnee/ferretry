import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgendaGate } from '@ferretry/protocol';
import {
  FILES_NOT_YET_COPY,
  STALE_ASK_COPY,
  type TypedAnswerTarget,
  type TypedSend,
  typedGateAnswer,
  withTypedSend,
} from '../../src/lib/agenda-gate-send.ts';

const tryIt: AgendaGate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Ready to try',
  entry: 3,
  projectId: 'p1',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};
const approval: AgendaGate = {
  ...tryIt,
  laneId: 'plan',
  options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }],
};

describe('what typed words are to a card’s own ask', () => {
  test('are Not good with the words as the reopen ask, and their files', () => {
    const answer = typedGateAnswer(
      { gate: tryIt },
      { message: '  The badge is red  ', attachmentIds: ['a1'] },
      'sess-1',
    );
    expect(answer).toEqual({
      kind: 'answer',
      action: expect.objectContaining({
        kind: 'respond',
        label: 'Not good',
        note: 'The badge is red',
        gate: true,
        cardAsk: 'gate:F12:tested:3',
        attachments: { from: 'sess-1', ids: ['a1'] },
      }),
    });
  });

  test('are Not yet at an approval, which takes words alone', () => {
    const answer = typedGateAnswer({ gate: approval }, { message: 'Add a test' }, 'sess-1');
    expect(answer.kind).toBe('answer');
    if (answer.kind !== 'answer') return;
    expect(answer.action).toMatchObject({ kind: 'respond', label: 'Not yet', note: 'Add a test' });
    expect(answer.action).not.toHaveProperty('attachments');
  });

  test('refuse files at an approval, saying so, so the box keeps the words and the files (never dropped)', () => {
    const answer = typedGateAnswer(
      { gate: approval },
      { message: 'Please use the attached design', attachmentIds: ['screenshot-1'] },
      'sess-1',
    );
    expect(answer).toEqual({ kind: 'refused', message: FILES_NOT_YET_COPY });
  });

  test('leave out files when there are none', () => {
    const answer = typedGateAnswer({ gate: tryIt }, { message: 'Wrong', attachmentIds: [] }, 'sess-1');
    expect(answer.kind === 'answer' && 'attachments' in answer.action).toBe(false);
    const bare = typedGateAnswer({ gate: tryIt }, { message: 'Wrong' }, 'sess-1');
    expect(bare.kind === 'answer' && 'attachments' in bare.action).toBe(false);
  });

  test('are nothing yet when they are blank, or the gate takes no words', () => {
    expect(typedGateAnswer({ gate: tryIt }, { message: '   ' }, 's')).toEqual({
      kind: 'refused',
      message: 'Type what you want to say first.',
    });
    expect(typedGateAnswer({ gate: { ...tryIt, options: [] } }, { message: 'x' }, 's').kind).toBe('refused');
  });
});

describe('a composer whose Send answers the ask it was built for', () => {
  const chatted: unknown[] = [];
  beforeEach(() => {
    chatted.length = 0;
  });
  const client = {
    send: (_session: string, input: unknown) => {
      chatted.push(input);
      return Promise.resolve({ chat: true });
    },
    other: () => 'kept',
  };
  const press = (wrapped: typeof client, input: TypedSend) =>
    (wrapped.send as unknown as (s: string, i: unknown) => Promise<unknown>)('sess-1', input);
  const target = (key: string, heard: TypedSend[]): TypedAnswerTarget => ({
    key,
    send: send => void heard.push(send),
    approves: words => words === 'works now',
  });
  const chatClient = {
    send: (session: string, input: unknown) => {
      chatted.push({ session, input });
      return Promise.resolve({ chat: true });
    },
    other: () => 'chat',
  };

  test('hands the words to the answer instead of chatting, and keeps every other method', async () => {
    const heard: TypedSend[] = [];
    const wrapped = withTypedSend(client, 'gate:F12:tested:3', () => target('gate:F12:tested:3', heard), chatClient);
    const result = await press(wrapped, { message: 'Wrong', attachmentIds: ['a1'] });
    expect(result).toEqual({});
    expect(heard).toEqual([{ message: 'Wrong', attachmentIds: ['a1'] }]);
    expect(chatted).toEqual([]);
    expect(wrapped.other()).toBe('kept');
  });

  test('sends words that plainly approve as the item’s ordinary reply, and does not answer the ask', async () => {
    const heard: TypedSend[] = [];
    const wrapped = withTypedSend(client, 'gate:F12:tested:3', () => target('gate:F12:tested:3', heard), chatClient);
    const result = await press(wrapped, { message: 'works now', attachmentIds: ['a1'] });
    expect(result).toEqual({ chat: true });
    expect(chatted).toEqual([{ session: 'sess-1', input: { message: 'works now', attachmentIds: ['a1'] } }]);
    expect(heard).toEqual([]);
  });

  test('lets the composer show the one line the answer throws', () => {
    const wrapped = withTypedSend(
      client,
      'k',
      () => ({
        key: 'k',
        send: () => {
          throw new Error('Type what you want to say first.');
        },
        approves: () => false,
      }),
      chatClient,
    );
    expect(() => press(wrapped, { message: '' })).toThrow('Type what you want to say first.');
  });

  test('never answers ANOTHER ask: a send for an ask that was replaced meanwhile fails with a plain line', () => {
    const replacement: TypedSend[] = [];
    let open: TypedAnswerTarget | undefined = target('gate:F12:tested:3', []);
    const wrapped = withTypedSend(client, 'gate:F12:tested:3', () => open, chatClient);
    // The ask is replaced (the card went back and came to a try-it again) before Send finally runs.
    open = target('gate:F12:tested:4', replacement);
    expect(() => press(wrapped, { message: 'The badge is red' })).toThrow(STALE_ASK_COPY);
    // Approving words are no exception: a reply is not sent for an ask that is gone either.
    expect(() => press(wrapped, { message: 'works now' })).toThrow(STALE_ASK_COPY);
    expect(replacement).toEqual([]);
    expect(chatted).toEqual([]);
  });

  test('fails the same way when the ask was answered or is gone', () => {
    const wrapped = withTypedSend(client, 'gate:F12:tested:3', () => undefined, chatClient);
    expect(() => press(wrapped, { message: 'late' })).toThrow(STALE_ASK_COPY);
    expect(chatted).toEqual([]);
  });
});
