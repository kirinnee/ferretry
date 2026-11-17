/**
 * The FAKE Codex sign-in a sweep slot's `codex-main` login carries, so the fixture's Codex runtime counts as signed in
 * ("Login codex-main needs sign-in" otherwise stops `codex-main-agent` from resuming).
 *
 * What counts as a Codex sign-in is the daemon's own rule (readCodexAuthFacts in the logins plugin): an `auth.json` with a
 * `tokens` object (an access token, a refresh token, an id token) and a `last_refresh`; Ready as long as the access token's
 * `exp` is not within five minutes. The fake `codex` in `support/` never reads the file, so nothing here has to be accepted by
 * a server: every value is a made-up marker (`fixture-…`, `fixture@example.invalid`), the JWTs carry the claims the daemon
 * reads and an unverifiable signature, and `exp` is far in the future so the login never turns "Refresh due".
 *
 * Built at run time (never a literal token in the source): the three JWTs are assembled from their parts here.
 */
const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** `header.payload.signature`, the signature a marker no verifier would accept. */
function fakeJwt(claims: Readonly<Record<string, unknown>>): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.fixture-unverifiable-signature`;
}

/** Ten years: the fake login never needs a refresh. */
const LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60;

/** The text of `auth.json` for the fixture's Codex login. `now` is injectable so a test pins the instants. */
export function fakeCodexAuthText(now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + LIFETIME_SECONDS;
  const document = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({
        iss: 'https://auth.invalid',
        aud: 'fixture',
        sub: 'fixture-subject',
        email: 'fixture@example.invalid',
        iat,
        exp,
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'fixture-account' },
      }),
      access_token: fakeJwt({ iss: 'https://auth.invalid', aud: 'fixture', sub: 'fixture-subject', iat, exp }),
      refresh_token: 'fixture-refresh-marker-not-a-real-token',
      account_id: 'fixture-account',
    },
    last_refresh: now.toISOString(),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
