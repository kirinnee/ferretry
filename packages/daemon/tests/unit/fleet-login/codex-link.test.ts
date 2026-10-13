/**
 * Codex's link sign-in, read from the outside: where its listener waits, and the one address a person
 * may bring back to it — proved against the authorize URL `codex login` was OBSERVED to print.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORTS,
  type CodexCallbackTarget,
  codexCallbackDelivery,
  codexCallbackTargetIn,
} from '../../../src/lib/fleet-login/codex-link.ts';

const STATE = 'J8F8NG4M_Xf_CimDSjX6AH1iWSM7Zj0EUFciJz-66PU';
const CODE = 'code-TESTONLY';

/** The shape codex-cli 0.145.0 printed, with the port and the state as parameters. */
const authorize = (redirect: string, state = STATE): string =>
  `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_TESTONLY&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=c&code_challenge_method=S256&state=${state}&originator=codex_cli_rs`;

const TARGET: CodexCallbackTarget = { port: 1455, path: CODEX_CALLBACK_PATH, state: STATE };
const ADDRESS = `http://localhost:1455/auth/callback?code=${CODE}&scope=openid+profile&state=${STATE}`;

describe('codexCallbackTargetIn', () => {
  it('should read the port and state out of the URL Codex printed, on either of its ports', () => {
    should(codexCallbackTargetIn(authorize('http://localhost:1455/auth/callback'))).deepEqual(TARGET);
    should(codexCallbackTargetIn(authorize('http://localhost:1457/auth/callback'))).deepEqual({
      ...TARGET,
      port: 1457,
    });
    should(CODEX_CALLBACK_PORTS).deepEqual([1455, 1457]);
  });

  it('should read the query by name, whatever order a Codex version prints it in', () => {
    // codex-cli 0.156.1 puts `state` before `scope` and encodes the scope with `+`.
    const reordered = `https://auth.openai.com/oauth/authorize?state=${STATE}&scope=openid+profile&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback`;

    should(codexCallbackTargetIn(reordered)).deepEqual(TARGET);
  });

  it('should refuse a URL whose callback this daemon could never deliver to', () => {
    const refused = [
      'https://auth.openai.com/codex/device',
      authorize('https://localhost:1455/auth/callback'),
      authorize('http://example.com:1455/auth/callback'),
      authorize('http://localhost:8080/auth/callback'),
      authorize('http://localhost:1455/elsewhere'),
      authorize('not a url'),
      authorize('http://localhost:1455/auth/callback', 'has space'),
      'https://auth.openai.com/oauth/authorize?state=abc',
      'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    ];

    for (const url of refused) should(codexCallbackTargetIn(url)).be.undefined();
  });
});

describe('codexCallbackDelivery', () => {
  it('should build the one request to Codex’s listener from the checked parts alone', () => {
    should(codexCallbackDelivery(`  ${ADDRESS}\n`, TARGET)).deepEqual({
      kind: 'deliver',
      delivery: { port: 1455, path: '/auth/callback', query: `code=${CODE}&scope=openid+profile&state=${STATE}` },
    });
  });

  it('should accept 127.0.0.1 for localhost, and carry an `iss` a provider adds', () => {
    const actual = codexCallbackDelivery(
      `http://127.0.0.1:1455/auth/callback?state=${STATE}&iss=https%3A%2F%2Fauth.openai.com&code=${CODE}`,
      TARGET,
    );

    should(actual).match({
      kind: 'deliver',
      delivery: { query: `code=${CODE}&state=${STATE}&iss=https%3A%2F%2Fauth.openai.com` },
    });
  });

  const refusals: readonly (readonly [string, string, RegExp])[] = [
    ['not an address', 'just-a-code', /not a web address/u],
    ['the sign-in link itself', authorize('http://localhost:1455/auth/callback'), /sign-in link itself/u],
    [
      'another host',
      `http://example.com:1455/auth/callback?code=${CODE}&state=${STATE}`,
      /starts with http:\/\/localhost\./u,
    ],
    ['https', `https://localhost:1455/auth/callback?code=${CODE}&state=${STATE}`, /starts with http:\/\/localhost\./u],
    ['credentials', `http://user:pw@localhost:1455/auth/callback?code=${CODE}&state=${STATE}`, /not the one Codex/u],
    [
      'another port',
      `http://localhost:1457/auth/callback?code=${CODE}&state=${STATE}`,
      /localhost:1455\/auth\/callback/u,
    ],
    ['another path', `http://localhost:1455/success?code=${CODE}&state=${STATE}`, /localhost:1455\/auth\/callback/u],
    ['a fragment', `${ADDRESS}#more`, /localhost:1455\/auth\/callback/u],
    ['a provider error', `http://localhost:1455/auth/callback?error=access_denied&state=${STATE}`, /did not finish/u],
    ['an unknown part', `${ADDRESS}&redirect=https%3A%2F%2Fevil.example`, /parts a Codex sign-in never has/u],
    ['a repeated part', `${ADDRESS}&code=second`, /parts a Codex sign-in never has/u],
    ['another attempt', `http://localhost:1455/auth/callback?code=${CODE}&state=other`, /different sign-in attempt/u],
    ['no code', `http://localhost:1455/auth/callback?state=${STATE}`, /no sign-in code/u],
    ['a code with a space', `http://localhost:1455/auth/callback?code=a+b&state=${STATE}`, /no sign-in code/u],
  ];

  for (const [name, pasted, reason] of refusals) {
    it(`should refuse ${name}, saying why without repeating it`, () => {
      const actual = codexCallbackDelivery(pasted, TARGET);

      should(actual).match({ kind: 'refused', reason });
      should(JSON.stringify(actual)).not.containEql(CODE);
    });
  }
});
