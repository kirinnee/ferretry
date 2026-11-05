import { describe, expect, test } from 'bun:test';
import type { AgendaGate } from '@ferretry/protocol';
import { typedGateAnswer, withTypedSend } from '../../src/lib/agenda-gate-send.ts';

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

  test('are Not yet at an approval, which takes words alone: its files are not sent', () => {
    const answer = typedGateAnswer({ gate: approval }, { message: 'Add a test', attachmentIds: ['a1'] }, 'sess-1');
    expect(answer.kind).toBe('answer');
    if (answer.kind !== 'answer') return;
    expect(answer.action).toMatchObject({ kind: 'respond', label: 'Not yet', note: 'Add a test' });
    expect(answer.action).not.toHaveProperty('attachments');
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

describe('a composer whose Send answers the card', () => {
  const client = { send: (_session: string, _input: unknown) => Promise.resolve({ chat: true }), other: () => 'kept' };

  test('hands the words to the answer instead of chatting, and keeps every other method', async () => {
    const heard: unknown[] = [];
    const wrapped = withTypedSend(client, send => heard.push(send));
    const result = await (wrapped.send as unknown as (s: string, i: unknown) => Promise<unknown>)('sess-1', {
      message: 'Wrong',
      attachmentIds: ['a1'],
    });
    expect(result).toEqual({});
    expect(heard).toEqual([{ message: 'Wrong', attachmentIds: ['a1'] }]);
    expect(wrapped.other()).toBe('kept');
  });

  test('lets the composer show the one line the answer throws', () => {
    const wrapped = withTypedSend(client, () => {
      throw new Error('Type what you want to say first.');
    });
    expect(() => (wrapped.send as unknown as (s: string, i: unknown) => unknown)('s', { message: '' })).toThrow(
      'Type what you want to say first.',
    );
  });
});
