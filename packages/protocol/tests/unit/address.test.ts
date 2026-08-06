import { describe, it } from 'bun:test';
import should from 'should';
import { daemonAddress, FY_DEFAULT_DAEMON_PORT, FY_DEFAULT_DAEMON_URL } from '../../src/lib/address.ts';

describe('the well-known daemon address', () => {
  it('should compose the default from the one port every side reads', () => {
    // Assert — a daemon that derives its address one way while a client derives it another is a
    // daemon the client cannot find, and neither end says anything.
    should(FY_DEFAULT_DAEMON_URL).equal(daemonAddress('127.0.0.1', FY_DEFAULT_DAEMON_PORT));
    should(FY_DEFAULT_DAEMON_URL).equal(`http://127.0.0.1:${String(FY_DEFAULT_DAEMON_PORT)}`);
  });

  it('should bracket an IPv6 authority exactly once', () => {
    // A configured host is a host SPELLING, so operators may write IPv6 either raw or bracketed.
    // Both must become the same valid URL; a raw `::1` classified as local-only is useless if the
    // pairing service cannot parse the address it was handed.
    should(daemonAddress('::1', 7_431)).equal('http://[::1]:7431');
    should(daemonAddress('[::1]', 7_431)).equal('http://[::1]:7431');
    should(daemonAddress('2001:db8::1', 7_432)).equal('http://[2001:db8::1]:7432');
  });

  it('should not be the port of the supervisor this product must coexist with', () => {
    // The inherited default collided on every machine this product is installed onto during the
    // migration — guaranteed, for exactly the audience that matters — and the two must run together.
    should(FY_DEFAULT_DAEMON_PORT).not.equal(7_337);
    // A usable well-known port: above the privileged range and below every platform's ephemeral one.
    should(FY_DEFAULT_DAEMON_PORT).be.above(1_024);
    should(FY_DEFAULT_DAEMON_PORT).be.below(32_768);
  });
});
