import { describe, it } from 'bun:test';
import should from 'should';
import {
  base64Url,
  flowIdentifier,
  flowState,
  pkcePair,
  sameText,
  tokenAnswer,
  tokenRefusal,
  VERIFIER_SHAPE,
} from '../../../src/lib/mcp-oauth/index.ts';
import { testCrypto } from './support.ts';

/** Bytes that are all the same value, so the encoding is checkable by hand. */
const fixed = (value: number) => ({
  randomBytes: (length: number) => new Uint8Array(length).fill(value),
  sha256: testCrypto.sha256,
});

describe('PKCE and the flow’s state', () => {
  it('should encode unpadded base64url', () => {
    should(base64Url(new Uint8Array([0xfb, 0xff]))).equal('-_8');
    should(base64Url(new Uint8Array([]))).equal('');
  });

  it('should make an RFC 7636 verifier and its S256 challenge (Appendix B vector)', async () => {
    // RFC 7636 Appendix B: this verifier's S256 challenge is the one below.
    const vector = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    should(base64Url(await testCrypto.sha256(vector))).equal('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

    const pair = await pkcePair(testCrypto);
    should(pair.verifier).match(VERIFIER_SHAPE);
    should(pair.verifier).have.length(43);
    should(pair.challenge).equal(base64Url(await testCrypto.sha256(pair.verifier)));
  });

  it('should make a state and a flow id from fresh randomness', () => {
    should(flowState(fixed(0))).equal('A'.repeat(43));
    should(flowIdentifier(fixed(0))).equal('A'.repeat(22));
    should(flowState(testCrypto)).not.equal(flowState(testCrypto));
  });

  it('should compare text without an early exit', () => {
    should(sameText('abc', 'abc')).be.true();
    should(sameText('abc', 'abd')).be.false();
    should(sameText('abc', 'ab')).be.false();
  });
});

describe('token and registration answers', () => {
  const TOKEN = 'access-0123456789';

  it('should read a Bearer token answer, with or without its optional parts', () => {
    should(
      tokenAnswer(
        200,
        JSON.stringify({
          access_token: TOKEN,
          token_type: 'bearer',
          expires_in: 60,
          refresh_token: 'refresh-0123456789',
          scope: 'a',
        }),
      ),
    ).deepEqual({
      kind: 'tokens',
      accessToken: TOKEN,
      refreshToken: 'refresh-0123456789',
      expiresInSeconds: 60,
      scope: 'a',
    });
    should(tokenAnswer(200, JSON.stringify({ access_token: TOKEN }))).deepEqual({ kind: 'tokens', accessToken: TOKEN });
  });

  it('should refuse a non-Bearer, too-short or unreadable success', () => {
    should(tokenAnswer(200, JSON.stringify({ access_token: TOKEN, token_type: 'mac' }))).deepEqual({
      kind: 'error',
      error: 'unreadable',
    });
    should(tokenAnswer(200, JSON.stringify({ access_token: 'short' }))).deepEqual({
      kind: 'error',
      error: 'unreadable',
    });
    should(tokenAnswer(200, 'not json')).deepEqual({ kind: 'error', error: 'unreadable' });
  });

  it('should read an error code and nothing else', () => {
    should(tokenAnswer(400, JSON.stringify({ error: 'invalid_grant', error_description: TOKEN }))).deepEqual({
      kind: 'error',
      error: 'invalid_grant',
    });
    should(tokenAnswer(500, '<html>')).deepEqual({ kind: 'error', error: 'unreadable' });
  });

  it('should word every refusal from a fixed table', () => {
    for (const code of ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope'])
      should(tokenRefusal(code)).not.equal(tokenRefusal('anything-else'));
    should(tokenRefusal('anything-else')).equal('The provider did not finish the sign-in. Start again.');
  });
});
