import { describe, it } from 'bun:test';
import should from 'should';
import {
  decideAdvertisement,
  isLoopbackHost,
  isLoopbackPeer,
  isWildcardHost,
  localOnlyNotice,
  refusalNotice,
  WILDCARD_BIND_HOST,
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

  it('should say who can redeem a link and what actually widens it', () => {
    // NEVER A DEAD END, AND NEVER A REMEDY THAT DOES NOT WORK. `publicUrl` alone is what this used to
    // say to a loopback bind, and following it left the daemon listening on loopback while the screen
    // started claiming a phone could dial the advertised address — the same dead end, now confident.
    const local = localOnlyNotice('http://127.0.0.1:7431');
    should(local.audience).containEql('Only a browser on this machine can redeem this link');
    should(local.audience).containEql('http://127.0.0.1:7431');
    should(local.audience).containEql('no QR');
    // The bind comes FIRST, and the wildcard is the spelling the predicate actually recognises.
    should(local.remedy).startWith(`bind every interface with "host": "${WILDCARD_BIND_HOST}"`);
    should(local.remedy).containEql('set "publicUrl" in <FY_HOME>/config/daemon.json');
    should(local.remedy).containEql('then restart the daemon');
    // And it promises what makes the fix safe to apply: the machine's own commands do not move.
    should(local.remedy).containEql('Commands on this machine keep reaching it on loopback');
    // A REMEDY MUST NAME WHAT IT OPENS. The wildcard is what lets the phone in, and the same edit lets
    // in everything else on that network — a widening the reader agrees to only if they are told.
    should(local.remedy).containEql('accepts connections from other devices on your network');
  });

  it('should stop calling a link unredeemable the moment a rendezvous can carry it', () => {
    // A published relay changes the AUDIENCE, not the reach: the direct address is still loopback,
    // and the link is still redeemable from another device — through the rendezvous, which is named
    // beside what it can observe, because the disclosure belongs next to the offer.
    const relayed = localOnlyNotice('http://127.0.0.1:7431', 'wss://relay.example');
    should(relayed.audience).containEql('another device can redeem it through the rendezvous at wss://relay.example');
    should(relayed.audience).containEql('http://127.0.0.1:7431');
    should(relayed.audience).containEql('observes connection metadata');
    should(relayed.audience).containEql('never read the code');
    should(relayed.audience).not.containEql('no QR');
    // The direct bind stays on offer as the upgrade it now is, with the same honest widening.
    should(relayed.remedy).startWith('for a direct connection that no rendezvous carries');
    should(relayed.remedy).containEql(`"host": "${WILDCARD_BIND_HOST}"`);
    should(relayed.remedy).containEql('e.g. http://192.168.1.10:7431');
    should(relayed.remedy).containEql('accepts connections from other devices on your network');
  });

  it('should carry the daemon’s own port into the example, never the compiled-in default', () => {
    // ADVICE WITH THE WRONG PORT IN IT IS ADVICE TO TYPE THE WRONG NUMBER. A first boot whose
    // preferred port was taken is on another one, and an example naming the default points at
    // whatever else holds it.
    should(localOnlyNotice('http://127.0.0.1:7500').remedy).containEql('e.g. http://192.168.1.10:7500');
    // A raw IPv6 loopback advertises through the same bracketed authority, and still yields a v4 example.
    should(localOnlyNotice('http://[::1]:7502').remedy).containEql('e.g. http://192.168.1.10:7502');
    // No port in the address is a daemon on the scheme's own port, so the example carries none either.
    should(localOnlyNotice('http://localhost').remedy).containEql('e.g. http://192.168.1.10,');
    // An address this cannot parse still yields a remedy: it is the state that most needs one.
    should(localOnlyNotice('   ').remedy).containEql('e.g. http://192.168.1.10,');
  });

  it('should give each refusal the remedy that is true for it, and no other', () => {
    // ONE SENTENCE FOR ALL THREE WAS FALSE FOR TWO OF THEM. A wildcard bind needs only somewhere to
    // point a device; a missing port has nothing bound at all, so `publicUrl` cannot help it.
    const wildcard = refusalNotice('wildcard-bind');
    should(wildcard.audience).containEql('binds every interface');
    should(wildcard.remedy).startWith('set "publicUrl" in <FY_HOME>/config/daemon.json');
    should(wildcard.remedy).containEql('then restart the daemon');
    // It must NOT tell an already-wildcard daemon to bind the wildcard again.
    should(wildcard.remedy).not.containEql('bind every interface');

    const noPort = refusalNotice('no-port');
    should(noPort.audience).containEql('no port recorded');
    should(noPort.remedy).containEql('start the daemon once so it records the port it takes');
    should(noPort.remedy).containEql('cannot supply an address nothing has bound');

    // Never emitted by the decision, kept for readers that still speak it: the two-step answer, with
    // no port known to put in the example.
    const loopback = refusalNotice('loopback-bind');
    should(loopback.audience).containEql('only advertises loopback');
    should(loopback.remedy).startWith(`bind every interface with "host": "${WILDCARD_BIND_HOST}"`);
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
