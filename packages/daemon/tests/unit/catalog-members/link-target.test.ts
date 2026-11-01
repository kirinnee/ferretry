import { describe, it } from 'bun:test';
import type { Advertisement } from '@ferretry/protocol';
import should from 'should';
import { shareLinkTarget } from '../../../src/lib/catalog-members/link-target.ts';
import { APP_ORIGIN, DAEMON_ID, DAEMON_URL } from './support.ts';

const RELAY_URL = 'wss://relay.ferretry.test';
const LOOPBACK_URL = 'http://127.0.0.1:7077';

const unavailable = (target: ReturnType<typeof shareLinkTarget>): string => {
  if (target.kind !== 'unavailable') throw new Error('expected no link');
  return target.reason;
};

describe('shareLinkTarget', () => {
  it('should point at the address another device can dial', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'address', url: DAEMON_URL, origin: 'operator' };

    // Act
    const target = shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN, undefined);

    // Assert
    should(target).eql({ kind: 'ready', appOrigin: APP_ORIGIN, daemonUrl: DAEMON_URL, daemonId: DAEMON_ID });
  });

  it('should say the machine is still starting when there is no advertisement', () => {
    // Arrange / Act
    const reason = unavailable(shareLinkTarget(undefined, DAEMON_ID, APP_ORIGIN, RELAY_URL));

    // Assert
    should(reason).containEql('still starting');
  });

  it('should say the machine is still starting when its id is not known yet', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'address', url: DAEMON_URL, origin: 'derived' };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, undefined, APP_ORIGIN, RELAY_URL));

    // Assert
    should(reason).containEql('still starting');
  });

  it('should carry the loopback address when another browser can find the relay this machine dials', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'local-only', url: LOOPBACK_URL };

    // Act
    const target = shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN, RELAY_URL);

    // Assert
    should(target).eql({ kind: 'ready', appOrigin: APP_ORIGIN, daemonUrl: LOOPBACK_URL, daemonId: DAEMON_ID });
  });

  it('should refuse a loopback-only machine on no discoverable relay, naming both ways out', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'local-only', url: LOOPBACK_URL };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN, undefined));

    // Assert
    should(reason).containEql('loopback');
    should(reason).containEql('not on a relay');
    should(reason).containEql('"source": "discovery"');
    should(reason).containEql('publicUrl');
  });

  it('should judge a loopback public address as a loopback bind: refused alone, relayed beside a rendezvous', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'address', url: 'http://localhost:7077', origin: 'operator' };

    // Act
    const alone = unavailable(shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN, undefined));
    const relayed = shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN, RELAY_URL);

    // Assert
    should(alone).containEql('not on a relay');
    should(relayed).eql({
      kind: 'ready',
      appOrigin: APP_ORIGIN,
      daemonUrl: 'http://localhost:7077',
      daemonId: DAEMON_ID,
    });
  });

  it('should name the missing port when there is none to put in a link', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'none', refusal: 'no-port' };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN, RELAY_URL));

    // Assert
    should(reason).containEql('no port');
    should(reason).containEql('publicUrl');
  });

  it('should refuse a wildcard bind with no public address even beside a relay, as pairing does', () => {
    // Arrange
    const advertisement: Advertisement = { kind: 'none', refusal: 'wildcard-bind' };

    // Act
    const reason = unavailable(shareLinkTarget(advertisement, DAEMON_ID, APP_ORIGIN, RELAY_URL));

    // Assert
    should(reason).containEql('every address');
    should(reason).containEql('publicUrl');
  });
});
