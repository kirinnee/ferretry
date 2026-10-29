import { describe, expect, it } from 'bun:test';
import type { AttentionId } from '@ferretry/protocol';
import { withReferencePrefix } from '../../src/lib/answer-chip.ts';

const id = (value: string): AttentionId => value as AttentionId;

const fakeClient = () => {
  const sent: string[] = [];
  return {
    sent,
    client: {
      tag: 'x',
      send: async (_id: string, body: { message: string }) => {
        sent.push(body.message);
      },
      who() {
        return this.tag;
      },
    },
  };
};

describe('withReferencePrefix', () => {
  it('prefixes every chip, in order, and binds other methods to the target', async () => {
    const { sent, client } = fakeClient();
    let chips: readonly AttentionId[] = [id('A4'), id('A7')];
    const wrapped = withReferencePrefix(client, () => chips);
    await wrapped.send('s', { message: 'hi' });
    chips = [];
    await wrapped.send('s', { message: 'hi' });
    expect(sent).toEqual(['!A4 !A7 hi', 'hi']);
    expect(wrapped.who()).toBe('x');
  });

  it('never prefixes a reference the message already carries', async () => {
    const { sent, client } = fakeClient();
    await withReferencePrefix(client, () => [id('A4')]).send('s', { message: '!A4 yes' });
    expect(sent).toEqual(['!A4 yes']);
  });
});
