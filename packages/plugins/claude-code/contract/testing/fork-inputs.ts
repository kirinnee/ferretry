import { expect, test } from 'bun:test';

/** Shared raw fixture: Conversation's visible inputs must be the turns selectable by Harness.fork. */
export const FORK_INPUTS = [
  { type: 'user', uuid: 'p1', message: { role: 'user', content: 'question 1' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'answer 1' } },
  {
    type: 'attachment',
    uuid: 'p2',
    attachment: {
      type: 'queued_command',
      commandMode: 'prompt',
      origin: { kind: 'human' },
      prompt: 'question 2',
    },
  },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: 'answer 2' } },
  { type: 'user', uuid: 'p3', message: { role: 'user', content: 'question 3' } },
  { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: 'answer 3' } },
  {
    type: 'user',
    uuid: 'p4',
    isMeta: true,
    origin: { kind: 'channel', server: 'ferretry' },
    message: { role: 'user', content: 'question 4' },
  },
  { type: 'assistant', uuid: 'a4', message: { role: 'assistant', content: 'answer 4' } },
  { type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'internal' } },
  {
    type: 'user',
    uuid: 'other-channel',
    isMeta: true,
    origin: { kind: 'channel', server: 'other' },
    message: { role: 'user', content: 'external channel' },
  },
];

/** The reader supplies its real parser through a structural test seam; no plugin's implementation crosses the boundary. */
export function forkInputs(parser: {
  parseRecord(record: unknown): {
    events: readonly {
      kind: string;
      role?: string;
      inputSource?: string;
      recordId?: string;
    }[];
  };
}): void {
  test('the shared fork fixture has four visible inputs, including the queue and Ferretry channel', () => {
    const visible = FORK_INPUTS.flatMap(record => parser.parseRecord(record).events).filter(
      event => event.kind === 'message' && event.role === 'user' && event.inputSource !== 'harness',
    );
    expect(visible.map(event => event.recordId)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
}
