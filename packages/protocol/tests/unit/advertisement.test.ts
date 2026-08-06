import { describe, it } from 'bun:test';
import should from 'should';
import {
  decideAdvertisement,
  FY_DEFAULT_DAEMON_PORT,
  isLoopbackHost,
  isLoopbackPeer,
  isWildcardHost,
  localOnlyNotice,
  recordedDaemonAddress,
  refusalNotice,
} from '@ferretry/protocol';

describe('the advertised address', () => {
  it('should hand out an address any device can dial when the bind names a real interface', () => {
    // Act + Assert
    should(decideAdvertisement({ host: '192.168.1.10', port: 7_431 })).deepEqual({
      kind: 'address',
      url: 'http://192.168.1.10:7431',
      origin: 'derived',
    });
    should(decideAdvertisement({ host: 'box.tailnet-abc.ts.net', port: 7_432 })).deepEqual({
      kind: 'address',
      url: 'http://box.tailnet-abc.ts.net:7432',
      origin: 'derived',
    });
  });

  it('should call a loopback bind local-only rather than refusing it', () => {
    // THE OWNER'S BLOCKER, AND THE REASON IT IS NOT A REFUSAL. A loopback-bound daemon is a working
    // daemon: a browser on its own machine pairs with it perfectly, and that is the commonest install
    // there is. Refusing it would break every default single-machine setup. What must never happen is
    // handing that address to a phone without saying so — the address is right for exactly one caller.
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      should(decideAdvertisement({ host, port: 7_431 })).have.property('kind', 'local-only');
    }
    should(decideAdvertisement({ host: 'localhost', port: 7_431 })).deepEqual({
      kind: 'local-only',
      url: 'http://localhost:7431',
    });
    should(decideAdvertisement({ host: '::1', port: 7_431 })).deepEqual({
      kind: 'local-only',
      url: 'http://[::1]:7431',
    });
    should(decideAdvertisement({ host: '[::1]', port: 7_431 })).deepEqual({
      kind: 'local-only',
      url: 'http://[::1]:7431',
    });
  });

  it('should refuse only when there is nothing at all to hand out', () => {
    // A wildcard bind SERVES fine; what is undefined is which address to give away. `0.0.0.0` is a
    // bind instruction, and a phone that dials it goes nowhere.
    should(decideAdvertisement({ host: '0.0.0.0', port: 7_431 })).deepEqual({
      kind: 'none',
      refusal: 'wildcard-bind',
    });
    should(decideAdvertisement({ host: '::', port: 7_431 })).deepEqual({ kind: 'none', refusal: 'wildcard-bind' });
    should(decideAdvertisement({ host: '[::]', port: 7_431 })).deepEqual({ kind: 'none', refusal: 'wildcard-bind' });
    // No port is no address. The wildcard is named first because the port has a well-known default
    // and the host does not, so it is the more useful thing to say.
    should(decideAdvertisement({ host: '192.168.1.10' })).deepEqual({ kind: 'none', refusal: 'no-port' });
    should(decideAdvertisement({ host: '0.0.0.0' })).deepEqual({ kind: 'none', refusal: 'wildcard-bind' });
  });

  it('should never second-guess an operator’s own advertised address', () => {
    // A REVERSE PROXY IS A LEGITIMATE DEPLOYMENT. Its address is deliberately not the one the daemon
    // binds, so reachability must never be re-derived from "the two differ" — that reads a correct
    // deployment as broken. The value is handed back verbatim, wildcard bind and all.
    should(
      decideAdvertisement({ operatorPublicUrl: 'https://box.example.test', host: '127.0.0.1', port: 7_431 }),
    ).deepEqual({ kind: 'address', url: 'https://box.example.test', origin: 'operator' });
    should(decideAdvertisement({ operatorPublicUrl: 'https://box.example.test', host: '0.0.0.0' })).deepEqual({
      kind: 'address',
      url: 'https://box.example.test',
      origin: 'operator',
    });
  });

  it('should treat an operator’s address as authoritative without reclassifying it from the bind', () => {
    // THE OPERATOR WINS. A reverse proxy or tunnel legitimately advertises an address the daemon
    // does not bind, and this layer has no proof with which to overrule the person who configured it.
    // Even an unusual or malformed value is returned verbatim; the daemon's document schema owns URL
    // validation, while this pure decision owns precedence.
    should(
      decideAdvertisement({ operatorPublicUrl: 'http://localhost:9000', host: '192.168.1.10', port: 7_431 }),
    ).deepEqual({ kind: 'address', url: 'http://localhost:9000', origin: 'operator' });
    should(decideAdvertisement({ operatorPublicUrl: 'not-an-address', host: '192.168.1.10', port: 7_431 })).deepEqual({
      kind: 'address',
      url: 'not-an-address',
      origin: 'operator',
    });
    // The configuration schema never admits this, but totality means the decision still returns it.
    should(decideAdvertisement({ operatorPublicUrl: '   ', host: '192.168.1.10', port: 7_431 })).deepEqual({
      kind: 'address',
      url: '   ',
      origin: 'operator',
    });
  });

  it('should read a daemon’s recorded address through the same decision the daemon uses', () => {
    // Act + Assert — a separate package with its own coverage ledger, which is why it reads the
    // decision rather than re-deriving it: the two disagreeing is a client dialling an address its
    // own daemon does not consider its own.
    should(recordedDaemonAddress({ host: '127.0.0.1', port: 7_432 })).equal('http://127.0.0.1:7432');
    should(recordedDaemonAddress({ host: '127.0.0.1', port: 7_432, publicUrl: 'https://box.test' })).equal(
      'https://box.test',
    );
    // A document that records a port but no host still names loopback, which is where a daemon binds.
    should(recordedDaemonAddress({ port: 7_432 })).equal('http://127.0.0.1:7432');
    // A local-only address is STILL returned: this reader runs on the host, which is the one caller
    // such an address is right for.
    should(recordedDaemonAddress({ host: 'localhost', port: 7_432 })).equal('http://localhost:7432');
  });

  it('should record nothing from a document that records nothing usable', () => {
    // Act + Assert — every one of these leaves a client at the well-known default, which fails
    // visibly as "the daemon is not answering" rather than by refusing to run at all.
    should(recordedDaemonAddress({})).be.undefined();
    should(recordedDaemonAddress({ host: '127.0.0.1' })).be.undefined();
    should(recordedDaemonAddress({ port: '7432' })).be.undefined();
    should(recordedDaemonAddress({ port: 7_432.5 })).be.undefined();
    should(recordedDaemonAddress({ publicUrl: '   ' })).be.undefined();
    should(recordedDaemonAddress({ host: '0.0.0.0', port: 7_432 })).be.undefined();
    should(recordedDaemonAddress(null)).be.undefined();
    should(recordedDaemonAddress('not a document')).be.undefined();
  });

  it('should say who can redeem a link and the one change that widens it', () => {
    // NEVER A DEAD END. Every sentence that withholds something names the edit that stops withholding
    // it, and the example carries the daemon's REAL port — advice with the default port in it is
    // advice to type the wrong number.
    const local = localOnlyNotice('http://127.0.0.1:7431');
    should(local.audience).containEql('Only a browser on this machine can redeem this link');
    should(local.audience).containEql('http://127.0.0.1:7431');
    should(local.audience).containEql('no QR');
    should(local.remedy).equal(
      `set publicUrl to the address other devices reach this machine at, e.g. http://192.168.1.10:${String(FY_DEFAULT_DAEMON_PORT)}`,
    );
    should(localOnlyNotice('http://localhost').remedy).equal(local.remedy);

    const wildcard = refusalNotice('wildcard-bind');
    should(wildcard.audience).containEql('binds every interface');
    should(wildcard.remedy).equal(local.remedy);
    should(refusalNotice('no-port').audience).containEql('no port recorded');
    should(refusalNotice('loopback-bind').audience).containEql('only advertises loopback');
  });
});

describe('what counts as loopback', () => {
  it('should read a host spelling and a peer address as the two different domains they are', () => {
    // ONE FACT, TWO INPUT DOMAINS. Five definitions of this predicate disagreed across four packages
    // and every one of them was locally right: an operator writes `localhost`, and a dual-stack socket
    // reports `::ffff:127.0.0.1`. Naming both makes reaching for the wrong one hard.
    should(isLoopbackHost('localhost')).be.true();
    should(isLoopbackHost('127.0.0.1')).be.true();
    should(isLoopbackHost('::1')).be.true();
    should(isLoopbackHost('[::1]')).be.true();
    should(isLoopbackHost('192.168.1.10')).be.false();
    should(isLoopbackHost('0.0.0.0')).be.false();
    // A name is never a peer address, and the IPv4-mapped form is never something an operator writes.
    should(isLoopbackPeer('::ffff:127.0.0.1')).be.true();
    should(isLoopbackPeer('127.0.0.1')).be.true();
    should(isLoopbackPeer('::1')).be.true();
    should(isLoopbackPeer('localhost')).be.false();
    should(isLoopbackPeer('10.0.0.4')).be.false();
  });

  it('should tell a wildcard bind apart from both of them', () => {
    should(isWildcardHost('0.0.0.0')).be.true();
    should(isWildcardHost('::')).be.true();
    should(isWildcardHost('[::]')).be.true();
    should(isWildcardHost('127.0.0.1')).be.false();
    should(isWildcardHost('192.168.1.10')).be.false();
  });
});
