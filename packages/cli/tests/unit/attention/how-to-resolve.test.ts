import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_HOW_TO_RESOLVE, displayHowToResolve } from '../../../src/lib/attention/how-to-resolve';
import { CLEARS_WHEN } from '../../../src/lib/notify/request';

describe('displayHowToResolve', () => {
  it.each([
    'Answer this item on the attention board.',
    'Answer this item on the attention board (it records who answered).',
  ])('should read the legacy default %j as the current default', legacy => {
    // Arrange + Act
    const actual = displayHowToResolve(legacy);

    // Assert
    should(actual).equal(DEFAULT_HOW_TO_RESOLVE);
  });

  it('should read the legacy notice default as the current notice default', () => {
    // Arrange + Act
    const actual = displayHowToResolve('Acknowledge it on the attention board (Got it).');

    // Assert
    should(actual).equal(CLEARS_WHEN);
  });

  it('should leave the current default alone', () => {
    should(displayHowToResolve(DEFAULT_HOW_TO_RESOLVE)).equal(DEFAULT_HOW_TO_RESOLVE);
  });

  it.each([
    'Answer this item on the attention board',
    'answer this item on the attention board.',
    ' Answer this item on the attention board. ',
    'Run `deploy` then Answer this item on the attention board.',
    'Reply in chat.',
  ])('should not touch text that is not an exact legacy default: %j', text => {
    should(displayHowToResolve(text)).equal(text);
  });
});
