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

  it('should close with a code the peer receives intact', () => {
    should(DEVICE_UNPAIRED_CLOSE).deepEqual({ code: 1008, reason: 'this device is no longer paired' });
  });
});
