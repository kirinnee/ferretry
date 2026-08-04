import { describe, it } from 'bun:test';
import {
  CREDIT_WINDOW_FRAMES,
  creditToReturn,
  grantCredit,
  maySend,
  newReceiveWindow,
  newSendWindow,
  recordConsumed,
  recordCredited,
  recordSent,
} from '@ferretry/relay';
import should from 'should';

describe('relay flow control', () => {
  it('should let a sender fill exactly one window and then stop', () => {
    let window = newSendWindow();
    for (let frame = 0; frame < CREDIT_WINDOW_FRAMES; frame += 1) {
      should(maySend(window)).be.true();
      window = recordSent(window);
    }
    should(maySend(window)).be.false();
  });

  it('should clamp a grant to the window however large the grant claims to be', () => {
    const filled = Array.from({ length: CREDIT_WINDOW_FRAMES }).reduce<ReturnType<typeof newSendWindow>>(
      accumulated => recordSent(accumulated),
      newSendWindow(),
    );
    const flooded = grantCredit(filled, 4_000_000_000);
    should(flooded.allowed - flooded.sent).equal(CREDIT_WINDOW_FRAMES);
    should(maySend(flooded)).be.true();
  });

  it('should ignore a grant that is not a positive whole number', () => {
    const window = newSendWindow();
    should(grantCredit(window, 0)).deepEqual(window);
    should(grantCredit(window, -3)).deepEqual(window);
    should(grantCredit(window, Number.NaN)).deepEqual(window);
  });

  it('should return credit in batches rather than one frame at a time', () => {
    let window = newReceiveWindow();
    for (let frame = 0; frame < CREDIT_WINDOW_FRAMES / 2 - 1; frame += 1) window = recordConsumed(window);
    should(creditToReturn(window)).equal(0);

    window = recordConsumed(window);
    const owed = creditToReturn(window);
    should(owed).equal(CREDIT_WINDOW_FRAMES / 2);
    should(creditToReturn(recordCredited(window, owed))).equal(0);
  });
});
