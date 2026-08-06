import type { PairingInvitationLink } from '@ferretry/protocol';
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

  it('should refuse a pairing URL that is not a v1 pairing claim at all', () => {
    // Without the `v1` prefix the PWA treats the fragment as somebody else's and shows the cold
    // screen, so a scan would look like nothing happened rather than like a broken link.
    should(() => checkedPairUrl(bent({ pairUrl: 'https://ferretry.pages.dev/pair#v2;code=X' }))).throw(
      'pairing URL does not carry a v1 pairing fragment',
    );
    should(() => checkedPairUrl(bent({ pairUrl: 'https://ferretry.pages.dev/pair' }))).throw(
      'pairing URL does not carry a v1 pairing fragment',
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
