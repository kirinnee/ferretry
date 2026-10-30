import { describe, it } from 'bun:test';
import should from 'should';
import { BoardError, BoardUnavailableError, BOARD_UNAVAILABLE_MESSAGE } from '../../../src/lib/board/index.ts';

describe('board errors', () => {
  it('should carry the refusal code and who may instead', () => {
    // Act
    const error = new BoardError('owner-gate', 'only the owner', ['owner-human']);

    // Assert
    should(error).match({ name: 'BoardError', code: 'owner-gate', allowed: ['owner-human'] });
    should(new BoardError('invalid', 'no').allowed).eql([]);
  });

  it('should keep the evidence of an unavailable board out of its message', () => {
    // Act
    const error = new BoardUnavailableError('card F1 at /home/someone/.ferretry/state/board is damaged');

    // Assert
    should(error.message).equal(BOARD_UNAVAILABLE_MESSAGE);
    should(error.detail).containEql('/home/someone');
  });
});
