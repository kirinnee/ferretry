import { describe, it } from 'bun:test';
import should from 'should';
import {
  hexInputChunks,
  terminalMetadataIsSane,
  terminalPaneTarget,
  terminalSnapshotFrame,
  terminalTmuxSessionName,
} from '../../../src/lib/terminal/index.ts';

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

  it('should build a self-contained redraw frame with normalized cursor coordinates', () => {
    // Act
    const frame = terminalSnapshotFrame('one\ntwo\n', -4, Number.NaN);

    // Assert
    should(frame).equal('\u001b[3J\u001b[2J\u001b[Hone\r\ntwo\u001b[1;1H');
  });

  it('should accept only plausible recovered terminal metadata', () => {
    // Arrange
    const valid = {
      id: '0123456789ab',
      owner: 'session-a',
      title: 'Terminal 1',
      root: '/tmp/worktree',
      tmuxSession: 'fy-webterm-session-a-deadbeef-0123456789ab',
      createdAtMs: 1,
      lastActivityAtMs: 2,
      cols: 100,
      rows: 30,
    };

    // Act + Assert
    should(terminalMetadataIsSane(valid)).be.true();
    should(terminalMetadataIsSane({ ...valid, id: 'unsafe' })).be.false();
    should(terminalMetadataIsSane({ ...valid, root: 'relative' })).be.false();
    should(terminalMetadataIsSane({ ...valid, lastActivityAtMs: 0 })).be.false();
  });
});
