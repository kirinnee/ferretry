import { describe, it } from 'bun:test';
import should from 'should';
import {
  CATALOG_SHARE_MINT_PATH,
  isCredentialMintAddress,
  isPairingMintAddress,
  isShareMintAddress,
  PAIRING_MINT_BODY_HIDDEN,
  PAIRING_MINT_PATH,
  PAIRING_SCREEN_META_NAME,
  PAIRING_SCREEN_REFUSAL,
  PAIRING_SCREEN_SEEN_META_NAME,
  PAIRING_SCREEN_SEEN_SELECTOR,
  PAIRING_SCREEN_SELECTOR,
} from '../../src/pairing-screen.ts';

/** The v4 B201 contract (PR 1597), word for word: the 5.0 marker must be the same one. */
describe('the shared pairing-screen marker', () => {
  it('names the same meta element v4 does', () => {
    should(PAIRING_SCREEN_META_NAME).equal('ferretry-pairing-screen');
    should(PAIRING_SCREEN_SELECTOR).equal('meta[name="ferretry-pairing-screen"]');
  });

  it('refuses with EXACTLY the sentence v4 PR 1597 sends, byte for byte, and no content', () => {
    should(PAIRING_SCREEN_REFUSAL).equal(
      'hidden: this page shows a pairing code, so it cannot be read or pictured. Ask the owner to finish or close it; navigating away or closing the page works.',
    );
  });

  it('prints the agreed text in place of a mint response body', () => {
    should(PAIRING_MINT_BODY_HIDDEN).equal('(body not shown: a pairing code)');
  });
});

describe('the catalog share mint address', () => {
  it('names the route that mints a join invite, and anything under it, and nothing that merely looks alike', () => {
    should(CATALOG_SHARE_MINT_PATH).equal('/v1/catalog-shares');
    for (const address of [
      'https://daemon.example.test/v1/catalog-shares',
      'https://daemon.example.test/v1/catalog-shares/shr_abc',
      '/v1/catalog-shares?x=1#y',
    ]) {
      should(isShareMintAddress(address)).be.true();
      should(isCredentialMintAddress(address)).be.true();
    }
    for (const address of [
      'https://daemon.example.test/v1/catalog-sharesx',
      'https://daemon.example.test/v1/catalogs',
      'https://daemon.example.test/x/v1/catalog-shares',
    ]) {
      should(isShareMintAddress(address)).be.false();
      should(isCredentialMintAddress(address)).be.false();
    }
  });

  it('counts the pairing mint as a credential too', () => {
    should(isCredentialMintAddress('https://daemon.example.test/v1/pair/code')).be.true();
  });
});

describe('the pairing mint address', () => {
  it('names the route that mints, and anything under it, and nothing that merely looks alike', () => {
    should(PAIRING_MINT_PATH).equal('/v1/pair/code');
    for (const address of [
      'https://daemon.example.test/v1/pair/code',
      'https://daemon.example.test/v1/pair/code/fy_pair_abc',
      'https://daemon.example.test/v1/pair/code?x=1#y',
      '/v1/pair/code',
    ])
      should(isPairingMintAddress(address)).be.true();
    for (const address of [
      'https://daemon.example.test/v1/pair/codes',
      'https://daemon.example.test/v1/pair/devices',
      'https://daemon.example.test/v1/pair',
      'https://daemon.example.test/x/v1/pair/code',
    ])
      should(isPairingMintAddress(address)).be.false();
  });

  it('fails closed on an address nothing can parse that still names the route', () => {
    should(isPairingMintAddress('http://[bad/v1/pair/code')).be.true();
    should(isPairingMintAddress('http://[bad/elsewhere')).be.false();
  });
});

describe('the sighting counter', () => {
  it('has its own name, distinct from the marker', () => {
    should(PAIRING_SCREEN_SEEN_META_NAME).equal('ferretry-pairing-screen-seen');
    should(PAIRING_SCREEN_SEEN_SELECTOR).equal('meta[name="ferretry-pairing-screen-seen"]');
    should(PAIRING_SCREEN_SEEN_META_NAME).not.equal(PAIRING_SCREEN_META_NAME);
  });
});
