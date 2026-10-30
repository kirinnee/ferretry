import { describe, it } from 'bun:test';
import should from 'should';
import { resolveCardFlag } from '../../../src/lib/attention/card-flag';

describe('the --task flag', () => {
  it('should name the card a card reference names, in any spelling', () => {
    // Act / Assert
    should(resolveCardFlag(['ask'], { task: 'F18' })).deepEqual({ words: ['ask'], todo: false, card: { id: 'F18' } });
    should(resolveCardFlag([], { task: '&f18', todo: true })).deepEqual({ words: [], todo: true, card: { id: 'F18' } });
    should(resolveCardFlag([], { task: '#B3' }).card).deepEqual({ id: 'B3' });
  });

  it('should keep a bare --task and --todo as a to-do', () => {
    // Act / Assert
    should(resolveCardFlag(['log', 'in'], { task: true })).deepEqual({ words: ['log', 'in'], todo: true });
    should(resolveCardFlag(['log', 'in'], { todo: true })).deepEqual({ words: ['log', 'in'], todo: true });
    should(resolveCardFlag(['ask'], {})).deepEqual({ words: ['ask'], todo: false });
  });

  it('should put back a word a bare --task swallowed, and keep the to-do', () => {
    // Act / Assert
    should(resolveCardFlag(['the', 'key'], { task: 'Rotate' })).deepEqual({
      words: ['Rotate', 'the', 'key'],
      todo: true,
    });
  });
});
