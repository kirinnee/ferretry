import { describe, it } from 'bun:test';
import should from 'should';
import {
  daemonAddress,
  FY_DEFAULT_DAEMON_PORT,
  FY_DEFAULT_DAEMON_URL,
  isLoopbackHost,
  isLoopbackPeer,
  isWildcardHost,
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

describe('what an operator’s host spelling means', () => {
  it('should read the whole of 127/8 and not only the familiar address', () => {
    // THE SHIPPED DEFECT. The command-line client read the whole block and this owner read one
    // address, so an operator who bound `127.0.0.2` to keep two daemons apart was on this machine
    // according to the token spent on them and a stranger according to the advertisement — which
    // minted a QR code for an address that, on the phone scanning it, names the phone.
    for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.255', '127.0.0.0']) {
      should(isLoopbackHost(host)).be.true();
    }
    // The block and nothing beside it, with every octet held to a real one.
    should(isLoopbackHost('128.0.0.1')).be.false();
    should(isLoopbackHost('126.255.255.255')).be.false();
    should(isLoopbackHost('127.0.0.256')).be.false();
    should(isLoopbackHost('127.0.0')).be.false();
    should(isLoopbackHost('127.0.0.1.example.test')).be.false();
  });

  it('should read every name RFC 6761 reserves for loopback, in any case', () => {
    // `.localhost` resolves to loopback and to nothing else, so a daemon named there is on this
    // machine; a host name is case-insensitive, so the spelling an operator chose cannot decide it.
    should(isLoopbackHost('localhost')).be.true();
    should(isLoopbackHost('LOCALHOST')).be.true();
    should(isLoopbackHost('fy.localhost')).be.true();
    should(isLoopbackHost('Deep.Sub.LocalHost')).be.true();
    should(isLoopbackHost('  localhost  ')).be.true();
    // A name that merely ENDS in the word is a different name.
    should(isLoopbackHost('notlocalhost')).be.false();
    should(isLoopbackHost('localhost.example.test')).be.false();
  });

  it('should read every spelling of IPv6 loopback, bracketed or not', () => {
    // A configured host may be written raw and a URL authority carries it bracketed, so both reach
    // this predicate. `::1` and its fully written form are one address and must answer alike.
    for (const host of [
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '[0:0:0:0:0:0:0:1]',
      '0000:0000:0000:0000:0000:0000:0000:0001',
    ]) {
      should(isLoopbackHost(host)).be.true();
    }
    should(isLoopbackHost('::2')).be.false();
    should(isLoopbackHost('2001:db8::1')).be.false();
    should(isLoopbackHost('1:0:0:0:0:0:0:1')).be.false();
  });

  it('should refuse a spelling that is not an address at all', () => {
    // Guessing wrong in this direction spends an owner-only credential off this machine, so anything
    // that does not read as an address takes the refusal rather than a benefit of the doubt.
    should(isLoopbackHost('1::2::3')).be.false();
    should(isLoopbackHost('::zz')).be.false();
    should(isLoopbackHost('gg::1')).be.false();
    should(isLoopbackHost('1:2:3')).be.false();
    should(isLoopbackHost('1:2:3:4:5:6:7:8:9')).be.false();
    // `::` stands for at least one elided group, so a spelling that already has eight is not one.
    should(isLoopbackHost('0:0:0:0::0:0:0:1')).be.false();
    should(isLoopbackHost('')).be.false();
  });

  it('should read every spelling of the unspecified address as a wildcard bind', () => {
    // `::`, `::0` and the written-out form are ONE bind. A list holding only the first called the
    // other two a routable interface, so a daemon bound to everything under either of them had an
    // advertisement composed out of a bind instruction instead of the refusal that names the remedy.
    for (const host of [
      '0.0.0.0',
      '::',
      '[::]',
      '::0',
      '[::0]',
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
    ]) {
      should(isWildcardHost(host)).be.true();
    }
    should(isWildcardHost('127.0.0.1')).be.false();
    should(isWildcardHost('192.168.1.10')).be.false();
    should(isWildcardHost('::1')).be.false();
    should(isWildcardHost('localhost')).be.false();
    should(isWildcardHost('nonsense')).be.false();
  });

  it('should keep the two input domains apart in both directions', () => {
    // ONE FACT, TWO DOMAINS. A name is something an operator writes and a transport never reports;
    // the IPv4-mapped form is what a dual-stack socket reports and no operator writes. Merging them
    // would be as wrong as the duplication that made this predicate authoritative.
    should(isLoopbackPeer('::ffff:127.0.0.1')).be.true();
    should(isLoopbackHost('::ffff:127.0.0.1')).be.false();
    should(isLoopbackPeer('localhost')).be.false();
    should(isLoopbackPeer('10.0.0.4')).be.false();
  });
});
