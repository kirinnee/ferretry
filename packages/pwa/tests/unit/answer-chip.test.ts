import { describe, expect, it } from 'bun:test';
import { answerPrefixed, withAnswerPrefix } from '../../src/lib/answer-chip.ts';

describe('answerPrefixed', () => {
  it('prefixes the reference when on', () => {
    expect(answerPrefixed('yes', 'A4', true)).toBe('!A4 yes');
  });
  it('leaves text alone when off or with no item', () => {
    expect(answerPrefixed('yes', 'A4', false)).toBe('yes');
    expect(answerPrefixed('yes', null, true)).toBe('yes');
  });
  it('never prefixes twice', () => {
    expect(answerPrefixed('!A4 yes', 'A4', true)).toBe('!A4 yes');
  });
});

describe('withAnswerPrefix', () => {
  it('prefixes send through the live chip state and binds other methods to the target', async () => {
    const sent: string[] = [];
    const target = {
      tag: 'x',
      send: async (_id: string, body: { message: string }) => {
        sent.push(body.message);
      },
      who() {
        return this.tag;
      },
    };
    let state: { id: string | null; on: boolean } = { id: 'A4', on: true };
    const wrapped = withAnswerPrefix(target, () => state);
    await wrapped.send('s', { message: 'hi' });
    state = { id: 'A4', on: false };
    await wrapped.send('s', { message: 'hi' });
    expect(sent).toEqual(['!A4 hi', 'hi']);
    expect(wrapped.who()).toBe('x');
  });
});
