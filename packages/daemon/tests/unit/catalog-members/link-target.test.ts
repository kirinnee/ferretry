import { describe, it } from 'bun:test';
import type { Advertisement } from '@ferretry/protocol';
import should from 'should';
import { shareLinkTarget } from '../../../src/lib/catalog-members/link-target.ts';
import { APP_ORIGIN, DAEMON_ID, DAEMON_URL } from './support.ts';

const unavailable = (target: ReturnType<typeof shareLinkTarget>): string => {
  if (target.kind !== 'unavailable') throw new Error('expected no link');
  return target.reason;
};

describe('shareLinkTarget', () => {
  it('should point at the address another device can dial', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'address', url: DAEMON_URL, origin: 'operator' };

    // Act
    const target = shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN);

    // Assert
    should(target).eql({ kind: 'ready', appOrigin: APP_ORIGIN, daemonUrl: DAEMON_URL, daemonId: DAEMON_ID });
  });

  it('should say the machine is still starting when there is no advertisement', () => {
    // Arrange / Act
    const reason = unavailable(shareLinkTarget(undefined, DAEMON_ID, APP_ORIGIN));

    // Assert
    should(reason).containEql('still starting');
  });

  it('should say the machine is still starting when its id is not known yet', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'address', url: DAEMON_URL, origin: 'derived' };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, undefined, APP_ORIGIN));

    // Assert
    should(reason).containEql('still starting');
  });

  it('should refuse a loopback-only address, which no other person can open', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'local-only', url: 'http://127.0.0.1:7077' };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN));

    // Assert
    should(reason).containEql('loopback');
    should(reason).containEql('publicUrl');
  });

  it('should name the missing port when there is none to put in a link', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'none', refusal: 'no-port' };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN));

    // Assert
    should(reason).containEql('no port');
    should(reason).containEql('publicUrl');
  });

  it('should name the wildcard bind when the machine listens on every address', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'none', refusal: 'wildcard-bind' };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN));

    // Assert
    should(reason).containEql('every address');
    should(reason).containEql('publicUrl');
  });
});
