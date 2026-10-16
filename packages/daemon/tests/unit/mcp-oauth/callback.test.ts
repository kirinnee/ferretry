import { describe, it } from 'bun:test';
import should from 'should';
import { type CallbackCheck, checkCallback, pwaRedirectUri } from '../../../src/lib/mcp-oauth/index.ts';

const EXPECTED = {
  redirectUri: 'https://ferretry.example.test/oauth/mcp-callback',
  state: 'the-flow-state-0123456789abcdef',
  issuer: 'https://auth.example.com/tenant',
};

const CODE = 'code-SECRET-VALUE-0123456789';
const GOOD = `${EXPECTED.redirectUri}?code=${CODE}&state=${EXPECTED.state}&iss=${encodeURIComponent(EXPECTED.issuer)}`;

/** A refusal's sentence, which must never quote the code. */
function reason(check: CallbackCheck): string {
  if (check.kind !== 'refused') throw new Error('expected a refusal');
  should(check.reason).not.containEql(CODE);
  return check.reason;
}

describe('the MCP sign-in addresses', () => {
  describe('pwaRedirectUri', () => {
    it('should accept the callback page on HTTPS, or on HTTP at this machine, normalised', () => {
      should(pwaRedirectUri('https://ferretry.pages.dev/oauth/mcp-callback')).equal(
        'https://ferretry.pages.dev/oauth/mcp-callback',
      );
      should(pwaRedirectUri('HTTPS://Ferretry.Pages.Dev:443/oauth/mcp-callback')).equal(
        'https://ferretry.pages.dev/oauth/mcp-callback',
      );
      should(pwaRedirectUri('http://127.0.0.1:5173/oauth/mcp-callback')).equal(
        'http://127.0.0.1:5173/oauth/mcp-callback',
      );
    });

    it('should refuse anything else', () => {
      for (const raw of [
        'not a url',
        'http://ferretry.pages.dev/oauth/mcp-callback',
        'https://ferretry.pages.dev/elsewhere',
        'https://ferretry.pages.dev/oauth/mcp-callback?x=1',
        'https://ferretry.pages.dev/oauth/mcp-callback#x',
        'https://u:p@ferretry.pages.dev/oauth/mcp-callback',
        'javascript:alert(1)',
      ])
        should(pwaRedirectUri(raw)).be.undefined();
    });
  });

  describe('checkCallback', () => {
    it('should answer the code from a well-formed address, trimmed', () => {
      should(checkCallback(`  ${GOOD}\n`, EXPECTED)).deepEqual({ kind: 'code', code: CODE });
      should(
        checkCallback(`${EXPECTED.redirectUri}?state=${EXPECTED.state}&code=${CODE}&scope=a&session_state=s`, EXPECTED),
      ).deepEqual({
        kind: 'code',
        code: CODE,
      });
    });

    it('should refuse something that is not an address', () => {
      should(reason(checkCallback('just some text', EXPECTED))).match(/not a web address/u);
    });

    it('should refuse an address on another origin or path, naming the expected start', () => {
      should(reason(checkCallback(GOOD.replace('ferretry.example.test', 'evil.example'), EXPECTED))).containEql(
        EXPECTED.redirectUri,
      );
      should(reason(checkCallback(GOOD.replace('/oauth/mcp-callback', '/oauth/other'), EXPECTED))).match(
        /not the one/u,
      );
    });

    it('should refuse credentials, a fragment and repeated keys', () => {
      should(reason(checkCallback(GOOD.replace('https://', 'https://u:p@'), EXPECTED))).match(
        /parts a sign-in never has/u,
      );
      should(reason(checkCallback(`${GOOD}#frag`, EXPECTED))).match(/parts a sign-in never has/u);
      should(reason(checkCallback(`${GOOD}&code=again`, EXPECTED))).match(/parts a sign-in never has/u);
    });

    it('should refuse a missing or different state', () => {
      should(reason(checkCallback(`${EXPECTED.redirectUri}?code=${CODE}`, EXPECTED))).match(
        /different sign-in attempt/u,
      );
      should(reason(checkCallback(GOOD.replace(EXPECTED.state, 'other-state'), EXPECTED))).match(
        /different sign-in attempt/u,
      );
    });

    it('should turn a provider error into a fixed sentence, never the provider’s description', () => {
      const failed = (error: string, extra = '') =>
        `${EXPECTED.redirectUri}?error=${error}&error_description=${encodeURIComponent('attacker text')}&state=${EXPECTED.state}${extra}`;
      should(reason(checkCallback(failed('access_denied'), EXPECTED))).match(/declined/u);
      should(reason(checkCallback(failed('invalid_scope'), EXPECTED))).match(/would not grant/u);
      should(reason(checkCallback(failed('unauthorized_client'), EXPECTED))).match(/does not let Ferretry/u);
      should(reason(checkCallback(failed('server_error'), EXPECTED))).equal(
        'The provider says that sign-in did not finish. Start again.',
      );
      should(reason(checkCallback(failed('server_error'), EXPECTED))).not.containEql('attacker');
      should(reason(checkCallback(failed('access_denied', '&odd=1'), EXPECTED))).match(/parts a sign-in never has/u);
    });

    it('should refuse unexpected keys, another issuer, and a missing or malformed code', () => {
      should(reason(checkCallback(`${GOOD}&next=https://evil.example`, EXPECTED))).match(/parts a sign-in never has/u);
      should(
        reason(
          checkCallback(GOOD.replace(encodeURIComponent(EXPECTED.issuer), 'https%3A%2F%2Fevil.example'), EXPECTED),
        ),
      ).match(/different sign-in provider/u);
      should(
        checkCallback(
          GOOD.replace(encodeURIComponent(EXPECTED.issuer), `${encodeURIComponent(EXPECTED.issuer)}%2F`),
          EXPECTED,
        ),
      ).deepEqual({
        kind: 'code',
        code: CODE,
      });
      should(reason(checkCallback(`${EXPECTED.redirectUri}?state=${EXPECTED.state}`, EXPECTED))).match(
        /no sign-in code/u,
      );
      should(reason(checkCallback(`${EXPECTED.redirectUri}?state=${EXPECTED.state}&code=a%20b`, EXPECTED))).match(
        /no sign-in code/u,
      );
    });
  });
});
