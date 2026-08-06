import { describe, it } from 'bun:test';
import should from 'should';
import {
  daemonAddress,
  FY_DEFAULT_DAEMON_PORT,
  FY_DEFAULT_DAEMON_URL,
  recordedBindAddress,
} from '../../src/lib/address.ts';

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

  it('should read the recorded BIND, so a client on this machine dials the socket and not the advertisement', () => {
    // THE DEFECT THIS REPLACES. Reading `publicUrl` here made an operator who advertised a routed
    // address — on the advice the pairing screen printed — dial that address from the very machine
    // the daemon runs on, where the loopback credential rule then correctly refused to spend the
    // owner-only token. Following the remedy broke the command that recommended it.
    should(recordedBindAddress({ host: '127.0.0.1', port: 7_432 })).equal('http://127.0.0.1:7432');
    should(recordedBindAddress({ host: '127.0.0.1', port: 7_432, publicUrl: 'https://box.test' })).equal(
      'http://127.0.0.1:7432',
    );
    // A document that records a port but no host still names loopback, which is where a daemon binds.
    should(recordedBindAddress({ port: 7_432 })).equal('http://127.0.0.1:7432');
    should(recordedBindAddress({ host: '  ', port: 7_432 })).equal('http://127.0.0.1:7432');
    // A host spelling is preserved, including a name and a raw IPv6 authority.
    should(recordedBindAddress({ host: 'localhost', port: 7_432 })).equal('http://localhost:7432');
    should(recordedBindAddress({ host: '::1', port: 7_432 })).equal('http://[::1]:7432');
    // A daemon on a routed interface is still dialled where it listens; whether a LOCAL credential
    // may travel there is a separate decision, and it is not this function's to make.
    should(recordedBindAddress({ host: '192.168.1.10', port: 7_432 })).equal('http://192.168.1.10:7432');
  });

  it('should answer loopback for a wildcard bind, at the port that was actually recorded', () => {
    // A wildcard is a bind instruction, not a destination. Answering with it sent a client to an
    // address nothing dials; answering `undefined` was worse still, because the client then fell back
    // to the well-known default PORT and reported a healthy daemon down while it served another one.
    for (const host of ['0.0.0.0', '::', '[::]']) {
      should(recordedBindAddress({ host, port: 9_000 })).equal('http://127.0.0.1:9000');
    }
  });

  it('should record nothing from a document that records nothing usable', () => {
    // Act + Assert — every one of these leaves a client at the well-known default, which fails
    // visibly as "the daemon is not answering" rather than by refusing to run at all.
    should(recordedBindAddress({})).be.undefined();
    should(recordedBindAddress({ host: '127.0.0.1' })).be.undefined();
    should(recordedBindAddress({ port: '7432' })).be.undefined();
    should(recordedBindAddress({ port: 7_432.5 })).be.undefined();
    // An advertisement is not an address to dial, so a document carrying only one records nothing.
    should(recordedBindAddress({ publicUrl: 'https://box.test' })).be.undefined();
    should(recordedBindAddress(null)).be.undefined();
    should(recordedBindAddress('not a document')).be.undefined();
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
