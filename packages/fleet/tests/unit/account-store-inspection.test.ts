/**
 * The words a sign-in ends with when its store held no usable login: every place looked in, and what
 * each held — never a value.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CredentialStoreCheck,
  storeInspectionWords,
  usableCredentialReading,
} from '../../src/lib/account/store-inspection.ts';
import type { CredentialReading } from '../../src/lib/identity.ts';

const ITEM = 'the keychain item "Claude Code-credentials" (account "sam")';
const FILE = 'the file /Users/sam/.claude/.credentials.json';

const words = (reading: CredentialReading, ...checked: CredentialStoreCheck[]): string =>
  storeInspectionWords({ reading, checked });

describe('usableCredentialReading', () => {
  it('should count a valid or refreshable login, and nothing else', () => {
    should(usableCredentialReading({ state: 'valid' })).be.true();
    should(usableCredentialReading({ state: 'refreshable' })).be.true();
    should(usableCredentialReading({ state: 'missing' })).be.false();
    should(usableCredentialReading({ state: 'unreadable' })).be.false();
  });
});

describe('storeInspectionWords', () => {
  it('should say a usable login is stored', () => {
    should(words({ state: 'valid' }, { location: ITEM, found: 'present' })).equal(
      'A usable login is stored for this credential.',
    );
  });

  it('should say nothing was looked at when nothing was', () => {
    should(words({ state: 'missing' })).equal('No place this login could be stored in was looked at.');
  });

  it('should name every place in order and say each was empty', () => {
    should(
      words({ state: 'missing' }, { location: ITEM, found: 'nothing' }, { location: FILE, found: 'nothing' }),
    ).equal(`Checked ${ITEM} — nothing there; then ${FILE} — nothing there.`);
  });

  it('should carry why a place could not be read', () => {
    should(
      words({ state: 'unreadable' }, { location: ITEM, found: 'unreadable', why: 'the keychain is locked' }),
    ).equal(`Checked ${ITEM} — could not be read: the keychain is locked.`);
    should(words({ state: 'unreadable' }, { location: ITEM, found: 'unreadable' })).equal(
      `Checked ${ITEM} — could not be read: no reason given.`,
    );
  });

  it('should say why a login that was there cannot be used', () => {
    const present: CredentialStoreCheck = { location: FILE, found: 'present' };

    should(words({ state: 'missing' }, present)).equal(
      `Checked ${FILE} — a login is there, but it cannot be used: it holds neither an access token nor a refresh token.`,
    );
    should(words({ state: 'missing', expiresAt: 1 }, present)).equal(
      `Checked ${FILE} — a login is there, but it cannot be used: it has expired and holds no refresh token to renew it.`,
    );
    should(words({ state: 'unreadable', reason: 'the Claude credential is not readable JSON' }, present)).equal(
      `Checked ${FILE} — a login is there, but it cannot be used: the Claude credential is not readable JSON.`,
    );
    should(words({ state: 'unreadable' }, present)).equal(
      `Checked ${FILE} — a login is there, but it cannot be used: its contents are not in a shape this version reads.`,
    );
  });
});
