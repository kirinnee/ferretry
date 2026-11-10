import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CredentialMaterial,
  classifyCredential,
  decodeJwtExpiry,
  type CredentialReading,
} from '../../../daemon/lib/shared/identity.ts';
import {
  type CredentialStoreInspection,
  storeInspectionWords,
  usableCredentialReading,
} from '../../../daemon/lib/shared/store-inspection.ts';

const NOW = 1_786_000_000_000;
const found = (blob: unknown): CredentialMaterial => ({ outcome: 'found', blob: JSON.stringify(blob) });
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('decodeJwtExpiry — only the clock, never the signature', () => {
  it('should read the exp claim as epoch milliseconds', () => {
    should(decodeJwtExpiry(`${segment({})}.${segment({ exp: 1_786_000_000.9 })}.sig`)).equal(1_786_000_000_900);
  });

  it('should read nothing from a token that is not three parts, not JSON or without a usable exp', () => {
    should(decodeJwtExpiry(42)).be.undefined();
    should(decodeJwtExpiry('only-one-part')).be.undefined();
    should(decodeJwtExpiry('head.')).be.undefined();
    should(decodeJwtExpiry(`${segment({})}.${Buffer.from('not json').toString('base64url')}.sig`)).be.undefined();
    should(decodeJwtExpiry(`${segment({})}.${segment({ exp: 'soon' })}.sig`)).be.undefined();
    should(decodeJwtExpiry(`${segment({})}.${segment({ exp: 0 })}.sig`)).be.undefined();
  });
});

describe('classifyCredential — what a store’s bytes mean at a moment', () => {
  it('should call a Claude credential with a live access token valid, with the expiry', () => {
    const material = found({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000 } });
    should(classifyCredential('claude', material, NOW)).eql({ state: 'valid', expiresAt: NOW + 3_600_000 });
  });

  it('should refuse to guess when an access token has no readable expiry', () => {
    should(classifyCredential('claude', found({ accessToken: 'a', refreshToken: 'r' }), NOW)).eql({
      state: 'unreadable',
      reason: 'the credential has an access token but no readable expiry',
    });
  });

  it('should call bytes that are not a JSON object unreadable, naming which credential, never missing', () => {
    for (const blob of ['[]', 'null', '"text"']) {
      should(classifyCredential('claude', { outcome: 'found', blob }, NOW)).eql({
        state: 'unreadable',
        reason: 'the Claude credential is not a JSON object',
      });
    }
    should(classifyCredential('codex', { outcome: 'found', blob: '{nope' }, NOW)).eql({
      state: 'unreadable',
      reason: 'the Codex credential is not readable JSON',
    });
  });

  it('should carry the reason a store could not be read, and call an absent one missing', () => {
    should(classifyCredential('codex', { outcome: 'unreadable', reason: 'permission denied' }, NOW)).eql({
      state: 'unreadable',
      reason: 'permission denied',
    });
    should(classifyCredential('codex', { outcome: 'absent' }, NOW)).eql({ state: 'missing' });
  });

  it('should keep an expired access token with a refresh token refreshable, and without one missing', () => {
    const expired = NOW - 3_600_000;
    should(classifyCredential('claude', found({ accessToken: 'a', refreshToken: 'r', expiresAt: expired }), NOW)).eql({
      state: 'refreshable',
      expiresAt: expired,
    });
    should(classifyCredential('claude', found({ accessToken: 'a', expiresAt: expired }), NOW)).eql({
      state: 'missing',
      expiresAt: expired,
    });
  });
});

describe('storeInspectionWords — where a store was looked and what each place held', () => {
  const reading = (state: CredentialReading['state'], extra: Partial<CredentialReading> = {}): CredentialReading => ({
    state,
    ...extra,
  });
  const words = (inspection: CredentialStoreInspection): string => storeInspectionWords(inspection);

  it('should treat only a valid or refreshable reading as usable', () => {
    should(usableCredentialReading(reading('valid'))).be.true();
    should(usableCredentialReading(reading('refreshable'))).be.true();
    should(usableCredentialReading(reading('missing'))).be.false();
    should(usableCredentialReading(reading('unreadable'))).be.false();
  });

  it('should say a usable login is stored, and that no place was looked at when none was', () => {
    should(words({ reading: reading('valid'), checked: [] })).equal('A usable login is stored for this credential.');
    should(words({ reading: reading('missing'), checked: [] })).equal(
      'No place this login could be stored in was looked at.',
    );
  });

  it('should say a place held nothing, or could not be read and why', () => {
    should(
      words({
        reading: reading('missing'),
        checked: [
          { location: 'the keychain item "Claude Code-credentials"', found: 'nothing' },
          { location: 'the file /home/you/.claude/.credentials.json', found: 'unreadable', why: 'permission denied' },
          { location: 'the file /srv/other.json', found: 'unreadable' },
        ],
      }),
    ).equal(
      'Checked the keychain item "Claude Code-credentials" — nothing there; then the file /home/you/.claude/.credentials.json — could not be read: permission denied; then the file /srv/other.json — could not be read: no reason given.',
    );
  });

  it('should say why a login that was read cannot be used, from its verdict alone', () => {
    const present = [{ location: 'the file /x.json', found: 'present' as const }];
    should(
      words({ reading: reading('unreadable', { reason: 'it was written by a newer harness' }), checked: present }),
    ).equal('Checked the file /x.json — a login is there, but it cannot be used: it was written by a newer harness.');
    should(words({ reading: reading('unreadable'), checked: present })).containEql(
      'its contents are not in a shape this version reads',
    );
    should(words({ reading: reading('missing'), checked: present })).containEql(
      'it holds neither an access token nor a refresh token',
    );
    should(words({ reading: reading('missing', { expiresAt: NOW }), checked: present })).containEql(
      'it has expired and holds no refresh token to renew it',
    );
  });
});
