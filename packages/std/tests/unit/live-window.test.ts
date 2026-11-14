import { describe, it } from 'bun:test';
import should from 'should';
import { LiveWindowLedger } from '../../src/live-window.ts';

/** The credential's own interval, kept by whoever mints it: a daemon-side fact no page script can reach. */
function ledger(capacity?: number) {
  const clock = { at: 1_000 };
  const window = new LiveWindowLedger(() => clock.at, capacity);
  return { clock, window };
}

describe('the live-window ledger', () => {
  it('is not live before anything is opened, and says nothing was live since any instant', () => {
    const { window } = ledger();
    should(window.live()).be.false();
    should(window.liveSince(0)).be.false();
  });

  it('is live from the open until the close, and remembers the interval afterwards', () => {
    const { clock, window } = ledger();
    window.open('a', 5_000);
    should(window.live()).be.true();
    clock.at = 1_500;
    window.close('a');
    clock.at = 2_000;
    should(window.live()).be.false();
    should(window.liveSince(1_000)).be.true();
    should(window.liveSince(1_500)).be.true();
    should(window.liveSince(1_501)).be.false();
  });

  it('ends at the deadline with no one asking, and still counts as live over the interval', () => {
    const { clock, window } = ledger();
    window.open('a', 2_000);
    clock.at = 2_001;
    should(window.live()).be.false();
    should(window.liveSince(1_999)).be.true();
    should(window.liveSince(2_001)).be.false();
  });

  it('keeps a replaced interval: the old one closed when the new one opened', () => {
    const { clock, window } = ledger();
    window.open('old', 9_000);
    clock.at = 1_200;
    window.close('old');
    window.open('new', 9_000);
    clock.at = 1_300;
    window.close('new');
    clock.at = 4_000;
    should(window.liveSince(1_100)).be.true();
    should(window.liveSince(1_250)).be.true();
    should(window.liveSince(1_301)).be.false();
  });

  it('is live while ANY of several keyed intervals is open', () => {
    const { clock, window } = ledger();
    window.open('a', 9_000);
    window.open('b', 9_000);
    window.close('a');
    clock.at = 1_100;
    should(window.live()).be.true();
    window.close('b');
    should(window.live()).be.false();
  });

  it('refuses to forget: a history that overflowed answers yes for anything it can no longer prove', () => {
    const { clock, window } = ledger(2);
    for (let index = 0; index < 5; index++) {
      clock.at = 1_000 + index * 100;
      window.open(`k${index}`, 99_000);
      clock.at += 10;
      window.close(`k${index}`);
    }
    clock.at = 9_000;
    should(window.liveSince(1_050)).be.true();
    should(window.liveSince(1_020)).be.true();
    should(window.liveSince(1_411)).be.false();
  });

  it('answers yes for a question about an instant in the future (the clock moved back)', () => {
    const { window } = ledger();
    should(window.liveSince(5_000)).be.true();
  });

  it('closing an unknown key is a no-op', () => {
    const { window } = ledger();
    window.close('never');
    should(window.live()).be.false();
  });
});
