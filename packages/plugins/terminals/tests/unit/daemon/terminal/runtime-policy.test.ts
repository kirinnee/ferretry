import { describe, it } from 'bun:test';
import should from 'should';
import { hexInputChunks, terminalPaneTarget, terminalTmuxSessionName } from '../../../src/lib/terminal/index.ts';

describe('terminal runtime policy', () => {
  it('should create stable bounded tmux session names without trusting display characters', () => {
    // Act
    const first = terminalTmuxSessionName('session/a', '0123456789ab');
    const second = terminalTmuxSessionName('session/a', '0123456789ab');
    const differentOwner = terminalTmuxSessionName('session-b', '0123456789ab');

    // Assert
    should(first).equal(second);
    should(first).startWith('fy-webterm-session-a-');
    should(first.length).be.belowOrEqual(80);
    should(differentOwner).not.equal(first);
  });

  it('should form an exact pane target and preserve every input byte in bounded hex chunks', () => {
    // Act
    const target = terminalPaneTarget({ tmuxSession: 'fy-webterm-one' });
    const chunks = hexInputChunks(new Uint8Array([0, 3, 13, 255, 9]), 2);

    // Assert
    should(target).equal('fy-webterm-one:0.0');
    should(chunks).deepEqual([['00', '03'], ['0d', 'ff'], ['09']]);
  });

  it('should reject an unsafe input chunk size', () => {
    // Act + Assert
    should(() => hexInputChunks(new Uint8Array(), 0)).throw(RangeError);
    should(() => hexInputChunks(new Uint8Array(), 0.5)).throw(RangeError);
  });
});
