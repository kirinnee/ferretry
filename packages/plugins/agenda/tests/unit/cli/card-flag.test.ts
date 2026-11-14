import { describe, it } from 'bun:test';
import should from 'should';
import { resolveCardFlag } from '../../../cli/lib/card-flag.ts';

describe('the --task flag', () => {
  it('should name the card a card reference names, in any spelling', () => {
    // Act / Assert
    should(resolveCardFlag(['ask'], { task: 'F18' })).deepEqual({ words: ['ask'], todo: false, card: { id: 'F18' } });
    should(resolveCardFlag([], { task: '&f18', todo: true })).deepEqual({ words: [], todo: true, card: { id: 'F18' } });
    should(() => resolveCardFlag([], { task: '#B3' })).throw(/--task needs a card reference/u);
  });

  it('should make a to-do of --todo alone', () => {
    // Act / Assert
    should(resolveCardFlag(['log', 'in'], { todo: true })).deepEqual({ words: ['log', 'in'], todo: true });
    should(resolveCardFlag(['ask'], {})).deepEqual({ words: ['ask'], todo: false });
  });

  it('should refuse a value that is not a card reference, pointing at --todo', () => {
    // Act / Assert
    should(() => resolveCardFlag(['the', 'key'], { task: 'Rotate' })).throw(
      '--task needs a card reference (F18 or &F18), not "Rotate"; for a to-do use --todo',
    );
    should(() => resolveCardFlag([], { task: 'F1x8' })).throw(/--task needs a card reference/u);
  });
});
