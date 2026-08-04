import { describe, it } from 'bun:test';
import should from 'should';
import {
  daemonAddress,
  FY_DEFAULT_DAEMON_PORT,
  FY_DEFAULT_DAEMON_URL,
  recordedDaemonAddress,
} from '../../src/lib/address.ts';

describe('the well-known daemon address', () => {
  it('should compose the default from the one port every side reads', () => {
    // Assert — a daemon that derives its address one way while a client derives it another is a
    // daemon the client cannot find, and neither end says anything.
    should(FY_DEFAULT_DAEMON_URL).equal(daemonAddress('127.0.0.1', FY_DEFAULT_DAEMON_PORT));
    should(FY_DEFAULT_DAEMON_URL).equal(`http://127.0.0.1:${String(FY_DEFAULT_DAEMON_PORT)}`);
  });

  it('should not be the port of the supervisor this product must coexist with', () => {
    // The inherited default collided on every machine this product is installed onto during the
    // migration — guaranteed, for exactly the audience that matters — and the two must run together.
    should(FY_DEFAULT_DAEMON_PORT).not.equal(7_337);
    // A usable well-known port: above the privileged range and below every platform's ephemeral one.
    should(FY_DEFAULT_DAEMON_PORT).be.above(1_024);
    should(FY_DEFAULT_DAEMON_PORT).be.below(32_768);
  });

  it('should read the address a daemon recorded for itself', () => {
    // Act + Assert
    should(recordedDaemonAddress({ host: '127.0.0.1', port: 7_432 })).equal('http://127.0.0.1:7432');
    // An operator's advertised address wins, exactly as the daemon resolves it.
    should(recordedDaemonAddress({ host: '127.0.0.1', port: 7_432, publicUrl: 'https://box.test' })).equal(
      'https://box.test',
    );
    // A document that records a port but no host still names loopback, which is where a daemon binds.
    should(recordedDaemonAddress({ port: 7_432 })).equal('http://127.0.0.1:7432');
  });

  it('should record nothing from a document that records nothing usable', () => {
    // Act + Assert — every one of these leaves a client at the well-known default, which fails
    // visibly as "the daemon is not answering" rather than by refusing to run at all.
    should(recordedDaemonAddress({})).be.undefined();
    should(recordedDaemonAddress({ host: '127.0.0.1' })).be.undefined();
    should(recordedDaemonAddress({ port: '7432' })).be.undefined();
    should(recordedDaemonAddress({ port: 7_432.5 })).be.undefined();
    should(recordedDaemonAddress({ publicUrl: '   ' })).be.undefined();
    should(recordedDaemonAddress(null)).be.undefined();
    should(recordedDaemonAddress('not a document')).be.undefined();
  });
});
