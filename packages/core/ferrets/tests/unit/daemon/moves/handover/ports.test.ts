import { describe, it } from 'bun:test';
import should from 'should';
import {
  HANDOVER_BOARD_PORT_METHODS,
  HandoverError,
  HandoverReceiptDamagedError,
} from '../../../src/lib/handover/types.ts';

/**
 * The port key set is the security property, so it is asserted rather than assumed.
 *
 * The whole operation turns on one proof: that the replacement received a working board capability
 * and used it. A `verify` on the orchestrator's own port would let the daemon write that proof about
 * itself, and the receipt would then attest to nothing. The types make an extra or missing key a
 * compile error; this pins it at run time as well, because the one edit both types would accept is
 * somebody widening the interface and the table together.
 */
describe('HandoverBoardPort', () => {
  it('exposes exactly the seven board writes a handover may make', () => {
    should(Object.keys(HANDOVER_BOARD_PORT_METHODS).sort()).deepEqual([
      'acceptInvitation',
      'approveChildGrant',
      'approveInvitation',
      'relinquish',
      'replaceCoordinator',
      'requestChildGrant',
      'requestInvitation',
    ]);
  });

  it('has no verify, and no other name a verification could hide behind', () => {
    const keys = Object.keys(HANDOVER_BOARD_PORT_METHODS);
    should(keys).not.containEql('verify');
    should(keys.filter(key => /verif/iu.test(key))).be.empty();
  });
});

/**
 * Absence and damage are different facts, and the type system is where the difference is kept.
 *
 * A store that answered "no receipt" for a document it could not read would let a second handover
 * begin on top of a half-applied first one, so the damaged case is a named error rather than a null —
 * and it carries the file, because the operator's next move is to go and look at it.
 */
describe('the handover errors', () => {
  it('names the failure cause a refusal answers with', () => {
    const error = new HandoverError('board_busy', 'the board already carries an outstanding invitation');
    should(error.name).equal('HandoverError');
    should(error.failure).equal('board_busy');
    should(error).be.instanceof(Error);
  });

  it('names the file and the reason a receipt could not be read as one', () => {
    const error = new HandoverReceiptDamagedError('/state/sessions/source-1/handover.json', 'unexpected token');
    should(error.name).equal('HandoverReceiptDamagedError');
    should(error.file).equal('/state/sessions/source-1/handover.json');
    should(error.detail).equal('unexpected token');
    should(error.message).match(/could not be read as one: unexpected token/u);
  });
});
