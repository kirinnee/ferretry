import { describe, it } from 'bun:test';
import should from 'should';
import { DEVICE_UNPAIRED_CLOSE, LiveDeviceConnections } from '../../../src/lib/pairing/index.ts';

describe('LiveDeviceConnections', () => {
  it('should end every connection one device holds, and no other device’s', () => {
    // Arrange
    const live = new LiveDeviceConnections();
    const ended: string[] = [];
    const end = (name: string) => () => ended.push(name);
    const shared = end('shared');
    live.track('phone', end('terminal'));
    live.track('phone', shared);
    live.track('phone', shared);
    live.track('laptop', end('laptop-feed'));

    // Act
    const count = live.endDevice('phone');

    // Assert — the same function handed over twice is still two connections.
    should(count).equal(3);
    should(ended).deepEqual(['terminal', 'shared', 'shared']);
    should(live.endDevice('laptop')).equal(1);
  });

  it('should forget a connection that ended on its own', () => {
    // Arrange
    const live = new LiveDeviceConnections();
    const ended: string[] = [];
    const releaseFirst = live.track('phone', () => ended.push('first'));
    const releaseSecond = live.track('phone', () => ended.push('second'));

    // Act
    releaseFirst();
    releaseSecond();
    // A release after the device's set was rebuilt touches only its own entry.
    live.track('phone', () => ended.push('third'));
    releaseFirst();

    // Assert
    should(live.endDevice('phone')).equal(1);
    should(ended).deepEqual(['third']);
  });

  it('should end a connection tracked for a device that was already unpaired', () => {
    // A socket ticket bought just before the revocation is redeemable for a few more seconds.
    // Arrange
    const live = new LiveDeviceConnections();
    live.endDevice('phone');
    const ended: string[] = [];

    // Act
    const release = live.track('phone', () => ended.push('late'));
    release();

    // Assert
    should(ended).deepEqual(['late']);
    should(live.endDevice('phone')).equal(0);
  });

  it('should end every connection even when one transport fails to close its own', () => {
    // Arrange
    const live = new LiveDeviceConnections();
    const ended: string[] = [];
    live.track('phone', () => {
      throw new Error('the socket was already torn down');
    });
    live.track('phone', () => ended.push('terminal'));

    // Act + Assert
    should(live.endDevice('phone')).equal(2);
    should(ended).deepEqual(['terminal']);
  });

  it('should ask every live connection again, skip released ones, and survive one that throws', () => {
    // Arrange
    const live = new LiveDeviceConnections();
    const asked: string[] = [];
    live.track(
      'phone',
      () => undefined,
      undefined,
      () => {
        throw new Error('this transport could not re-ask');
      },
    );
    live.track(
      'phone',
      () => undefined,
      undefined,
      () => asked.push('terminal'),
    );
    const release = live.track(
      'laptop',
      () => undefined,
      undefined,
      () => asked.push('gone'),
    );
    live.track('laptop', () => undefined);
    release();

    // Act
    live.recheckAll();

    // Assert
    should(asked).deepEqual(['terminal']);
  });

  describe('lapsing a device’s sessions after its key was replaced', () => {
    const lapseOf = (key: string, ended: string[]) => ({ key, end: () => ended.push(key) });

    it('should end every session of the device but the one that carried the replacement', () => {
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      live.track('phone', () => undefined, undefined, undefined, lapseOf('carrier', ended));
      live.track('phone', () => undefined, undefined, undefined, lapseOf('other-one', ended));
      live.track('phone', () => undefined, undefined, undefined, lapseOf('other-two', ended));
      live.track('laptop', () => undefined, undefined, undefined, lapseOf('laptop-session', ended));

      const count = live.lapseDevice('phone', 'carrier');

      should(count).equal(2);
      should(ended).deepEqual(['other-one', 'other-two']);
    });

    it('should end nothing and say so for a device with no lapsable session', () => {
      const live = new LiveDeviceConnections();
      live.track('phone', () => undefined);
      const ended: string[] = [];
      live.track('phone', () => undefined, undefined, undefined, lapseOf('only', ended));

      should(live.lapseDevice('stranger', 'x')).equal(0);
      should(live.lapseDevice('phone', 'only')).equal(0);
      should(ended).be.empty();
    });

    it('should lapse every remaining session when the excepted key is not among them', () => {
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      live.track('phone', () => undefined, undefined, undefined, lapseOf('a', ended));
      live.track('phone', () => undefined, undefined, undefined, lapseOf('b', ended));

      should(live.lapseDevice('phone', '')).equal(2);
      should(ended).deepEqual(['a', 'b']);
    });

    it('should not end the connection itself, only lapse it', () => {
      // A lapse is the lease-ended close, which the session performs; the tracker's own end is for an unpair.
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      live.track('phone', () => ended.push('unpair'), undefined, undefined, lapseOf('a', ended));

      live.lapseDevice('phone', 'none');

      should(ended).deepEqual(['a']);
    });

    it('should lapse the rest even when one transport fails to close its own', () => {
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      live.track('phone', () => undefined, undefined, undefined, {
        key: 'broken',
        end: () => {
          throw new Error('the socket was already torn down');
        },
      });
      live.track('phone', () => undefined, undefined, undefined, lapseOf('healthy', ended));

      should(live.lapseDevice('phone', 'carrier')).equal(2);
      should(ended).deepEqual(['healthy']);
    });

    it('should forget a lapse when its connection ends on its own, and keep a sibling’s', () => {
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      const releaseFirst = live.track('phone', () => undefined, undefined, undefined, lapseOf('first', ended));
      live.track('phone', () => undefined, undefined, undefined, lapseOf('second', ended));

      releaseFirst();

      should(live.lapseDevice('phone', 'carrier')).equal(1);
      should(ended).deepEqual(['second']);
    });

    it('should drop the device’s entry once its last lapse is released, so a later one starts clean', () => {
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      live.track('phone', () => undefined, undefined, undefined, lapseOf('first', ended))();

      should(live.lapseDevice('phone', 'carrier')).equal(0);
      live.track('phone', () => undefined, undefined, undefined, lapseOf('second', ended));
      should(live.lapseDevice('phone', 'carrier')).equal(1);
      should(ended).deepEqual(['second']);
    });

    it('should forget every lapse of a device that was unpaired', () => {
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      live.track('phone', () => undefined, undefined, undefined, lapseOf('a', ended));

      live.endDevice('phone');

      should(live.lapseDevice('phone', 'carrier')).equal(0);
      should(ended).be.empty();
    });

    it('should keep the lapse it was given even if the caller later changes its own object', () => {
      const live = new LiveDeviceConnections();
      const ended: string[] = [];
      const lapse = { key: 'original', end: () => ended.push('original') };
      live.track('phone', () => undefined, undefined, undefined, lapse);

      lapse.key = 'carrier';

      should(live.lapseDevice('phone', 'carrier')).equal(1);
      should(ended).deepEqual(['original']);
    });
  });

  it('should close with a code the peer receives intact', () => {
    should(DEVICE_UNPAIRED_CLOSE).deepEqual({ code: 1008, reason: 'this device is no longer paired' });
  });
});
