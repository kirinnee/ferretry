import { describe, it } from 'bun:test';
import should from 'should';
import {
  isPairingRedirectDirectoryName,
  isPairingRedirectStale,
  PAIRING_REDIRECT_LIFETIME_MS,
  PAIRING_REDIRECT_STALE_AFTER_MS,
} from '../../src/lib/pairing-redirect.ts';

describe('isPairingRedirectDirectoryName', () => {
  it('accepts exactly the shape mkdtemp gives the directory: the prefix and six alphanumerics', () => {
    should(isPairingRedirectDirectoryName('pair-open-aB3dE9')).be.true();
    should(isPairingRedirectDirectoryName('pair-open-000000')).be.true();
  });

  it('refuses a near miss, so a folder an operator happens to name like ours is never swept', () => {
    should(isPairingRedirectDirectoryName('pair-open-')).be.false();
    should(isPairingRedirectDirectoryName('pair-open-aB3dE')).be.false();
    should(isPairingRedirectDirectoryName('pair-open-aB3dE90')).be.false();
    should(isPairingRedirectDirectoryName('pair-open-aB3d_9')).be.false();
    should(isPairingRedirectDirectoryName('pair-open-aB3dE9/')).be.false();
    should(isPairingRedirectDirectoryName('x-pair-open-aB3dE9')).be.false();
    should(isPairingRedirectDirectoryName('pair-open-aB3dE9\n')).be.false();
    should(isPairingRedirectDirectoryName('pair-open-notes')).be.false();
  });
});

describe('isPairingRedirectStale', () => {
  it('leaves a page alone until it is three lifetimes old, because its owner may be running right now', () => {
    should(PAIRING_REDIRECT_STALE_AFTER_MS).equal(3 * PAIRING_REDIRECT_LIFETIME_MS);
    should(isPairingRedirectStale(1_000, 1_000)).be.false();
    should(isPairingRedirectStale(1_000, 1_000 + PAIRING_REDIRECT_STALE_AFTER_MS)).be.false();
    should(isPairingRedirectStale(1_000, 1_001 + PAIRING_REDIRECT_STALE_AFTER_MS)).be.true();
  });

  it('never calls a page from the future stale, however far ahead its clock was', () => {
    should(isPairingRedirectStale(10_000_000, 1_000)).be.false();
  });
});
