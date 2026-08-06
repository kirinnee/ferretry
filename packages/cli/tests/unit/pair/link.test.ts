import { type PairingInvitationLink, pairingLinkUrl } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { checkedPairUrl, pairingDaemonHost } from '../../../src/lib/pair/link';
import { CODE, DAEMON_ID, DAEMON_URL, PAIR_URL } from './fixtures';

/**
 * A minted link with one field bent, bypassing the protocol schema the way a rogue daemon would.
 *
 * It is the LINK rather than the whole mint, because that is what this check now takes: the daemon
 * either handed out an address or said why it did not, and there is nothing here to check in the
 * second case.
 */
const bent = (overrides: Partial<PairingInvitationLink>): PairingInvitationLink => ({
  daemonUrl: DAEMON_URL,
  pairUrl: PAIR_URL,
  reach: 'any-device',
  ...overrides,
});

describe('pairing link check', () => {
  it('should pass through the link the daemon minted, unchanged', () => {
    // The daemon builds this URL and the protocol schema binds it to the daemon, code and
    // fingerprint; rebuilding it here would only be a second opinion about the same contract.
    should(checkedPairUrl(bent({}))).equal(PAIR_URL);
    const parsed = new URL(PAIR_URL);
    should(parsed.search).equal('');
    should(parsed.hash).startWith('#v1;');
    should(parsed.hash).containEql(`code=${CODE}`);
    should(parsed.hash).containEql(`fp=${DAEMON_ID}`);
    // Nothing secret may survive outside the fragment — that is the whole security claim.
    should(PAIR_URL.slice(0, PAIR_URL.indexOf('#'))).not.containEql(CODE);
  });

  it('should refuse a daemon address the PWA reader would reject, on the host rather than on the phone', () => {
    // Each of these passes the protocol schema — `daemonUrl` is only checked to be a URL — and each
    // would then be refused by `daemonBaseUrl` after somebody had already scanned it.
    should(() => checkedPairUrl(bent({ daemonUrl: 'box.tailnet-abc.ts.net' }))).throw(/daemon URL must be absolute/u);
    should(() => checkedPairUrl(bent({ daemonUrl: 'ftp://box.tailnet-abc.ts.net' }))).throw(
      'daemon URL must use http or https',
    );
    should(() => checkedPairUrl(bent({ daemonUrl: 'https://user:pw@box.ts.net' }))).throw(
      'daemon URL may not carry credentials',
    );
    should(() => checkedPairUrl(bent({ daemonUrl: 'https://box.ts.net?a=1' }))).throw(
      'daemon URL may not carry a query or a fragment',
    );
    should(() => checkedPairUrl(bent({ daemonUrl: 'https://box.ts.net#x' }))).throw(
      'daemon URL may not carry a query or a fragment',
    );
    should(() => checkedPairUrl(bent({ daemonUrl: 'https://box.ts.net/proxy' }))).throw(
      'daemon URL must be an origin without a path',
    );
  });

  it('should accept a loopback daemon address, which is the ordinary on-host case', () => {
    should(checkedPairUrl(bent({ daemonUrl: 'http://127.0.0.1:7431', reach: 'local-only' }))).equal(PAIR_URL);
  });

  it('should accept the fragment version the daemon mints, through the owner rather than its own list', () => {
    // THE REGRESSION THIS PINS. This reader hard-coded `#v1;`, the daemon briefly learned to mint
    // `#v2;` whenever it published a rendezvous, and `fy pair` then refused the daemon's own link — no
    // code, no QR, no link, on the one screen that exists to hand a person all three. The fragment has
    // two readers, the host's own screen is one of them, and only the other one was taught the second
    // version.
    //
    // THE `v2` FORM IS WITHDRAWN AND THIS TEST STILL HAS WORK TO DO, which is why it is re-keyed
    // rather than deleted: what it now proves is that whatever the WRITER emits is accepted here. It
    // fails if this reader ever spells a version of its own again — the shape of the original defect —
    // because the link is built by the codec that owns the version rather than by this file.
    const minted = pairingLinkUrl('https://ferretry.pages.dev/pair', {
      daemonUrl: DAEMON_URL,
      code: CODE,
      daemonId: DAEMON_ID,
    });
    should(checkedPairUrl(bent({ pairUrl: minted }))).equal(minted);
    should(minted).not.containEql('relay');
  });

  it('should refuse a pairing URL that is not a pairing claim at all', () => {
    // Without a version prefix the PWA treats the fragment as somebody else's and shows the cold
    // screen, so a scan would look like nothing happened rather than like a broken link.
    should(() => checkedPairUrl(bent({ pairUrl: 'https://ferretry.pages.dev/pair#v9;code=X' }))).throw(
      'pairing URL does not carry a pairing fragment',
    );
    should(() => checkedPairUrl(bent({ pairUrl: 'https://ferretry.pages.dev/pair#somebody-elses' }))).throw(
      'pairing URL does not carry a pairing fragment',
    );
    should(() => checkedPairUrl(bent({ pairUrl: 'https://ferretry.pages.dev/pair' }))).throw(
      'pairing URL does not carry a pairing fragment',
    );
    should(() => checkedPairUrl(bent({ pairUrl: '/pair#v1;code=X' }))).throw(/pairing URL must be absolute/u);
    should(() => checkedPairUrl(bent({ pairUrl: 'javascript:alert(1)#v1;' }))).throw(
      'pairing URL must use http or https',
    );
  });

  it('should name the host, which is the part of an address a human can recognise', () => {
    should(pairingDaemonHost(DAEMON_URL)).equal('box.tailnet-abc.ts.net');
    should(pairingDaemonHost('http://127.0.0.1:7431')).equal('127.0.0.1:7431');
  });
});
