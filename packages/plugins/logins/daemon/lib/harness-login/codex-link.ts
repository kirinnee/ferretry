/**
 * Codex's ordinary browser login, read from the outside: the address it waits on, and the one address a
 * person may bring back to it.
 *
 * ## What this sign-in actually is, observed rather than inferred
 *
 * Read by running `codex login` (no flag) with **piped** stdio at codex-cli 0.145.0 and 0.156.1, with a
 * temporary `CODEX_HOME`. Everything is on stderr, without escapes:
 *
 *     Starting local login server on http://localhost:1455.
 *     If your browser did not open, navigate to this URL to authenticate:
 *
 *     https://auth.openai.com/oauth/authorize?response_type=code&client_id=…&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&…&code_challenge_method=S256&…&state=…
 *
 * Four facts follow, and each one shapes this file:
 *
 * 1. **Codex listens on the host and the provider sends the browser there.** On a phone that address is
 *    the phone itself, so the page fails to load — but the address bar still holds the whole answer. The
 *    person copies it, and the daemon delivers it to Codex's own listener on the host. Codex redeems it
 *    with the PKCE verifier only it holds and writes its own login. The daemon never redeems anything.
 * 2. **The port is not fixed.** Codex binds 1455, falls back to 1457 when something else holds 1455, and
 *    gives up — `Port 127.0.0.1:1457 is already in use` — when both are held. So the port is READ from
 *    the `redirect_uri` Codex printed and accepted only from that known pair.
 * 3. **Codex checks `state` itself and keeps waiting on a mismatch** (`400 State mismatch`), but exits on
 *    a missing or unusable code. The daemon checks `state` FIRST, so a stray or stale address is refused
 *    here, in words, without spending the sign-in.
 * 4. **Parameter order differs between versions** (0.156.1 moved `state` and encodes `scope` with `+`),
 *    so the query is parsed, never matched by position.
 *
 * ## THE PASTED ADDRESS IS A CREDENTIAL, AND IT PASSES THROUGH
 *
 * It carries an authorization code. {@link codexCallbackDelivery} reads it, checks it, and returns the
 * one request to make — and no refusal it answers with names any part of it. The service hands that
 * request to the delivery port and drops it. Nothing holds it, logs it or puts it on the wire.
 */

/** Where Codex's own listener waits for the provider's redirect. Exactly what the printed URL said. */
export interface CodexCallbackTarget {
  readonly port: number;
  readonly path: string;
  /** The OAuth `state` Codex printed, which the address coming back must carry unchanged. */
  readonly state: string;
}

/** One request to Codex's own listener on this host: path and query, never a host. */
export interface CodexCallbackDelivery {
  readonly port: number;
  readonly path: string;
  readonly query: string;
}

/** The two ports Codex was observed to listen on, in the order it tries them. */
export const CODEX_CALLBACK_PORTS: readonly number[] = [1455, 1457];

/** The path Codex's listener answers the provider's redirect on. */
export const CODEX_CALLBACK_PATH = '/auth/callback';

/** The hosts an address coming back may name. Both are this machine, which is the only place Codex listens. */
const CALLBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * The query keys a provider redirect carries. `scope` and `iss` are allowed because a provider may add
 * them (RFC 9207 adds `iss`); anything else is a value this flow has no reason to forward.
 */
const CALLBACK_KEYS: ReadonlySet<string> = new Set(['code', 'state', 'scope', 'iss']);

/** An OAuth `state` or `code` is printable ASCII with no spaces. Anything else is not one. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,2048}$/u;

/**
 * Where this Codex said it is waiting, if the line is its authorize URL and that URL names a callback
 * this flow can deliver to.
 *
 * Both halves are checked: the authorize page must be on a host the flow already trusts (the caller
 * passes it in after {@link verificationUrlIn}), and its `redirect_uri` must be plain `http` on this
 * machine, on a known port, at the known path, with a `state` beside it. A URL that fails any of that is
 * not published, because a person would be sent to sign in somewhere this daemon could never finish.
 */
export function codexCallbackTargetIn(authorizeUrl: string): CodexCallbackTarget | undefined {
  const url = new URL(authorizeUrl);
  if (!url.pathname.endsWith('/oauth/authorize')) return undefined;
  const redirect = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  if (redirect === null || state === null || !TOKEN_SHAPE.test(state) || !URL.canParse(redirect)) return undefined;
  const callback = new URL(redirect);
  const port = Number(callback.port);
  if (
    callback.protocol !== 'http:' ||
    !CALLBACK_HOSTS.includes(callback.hostname) ||
    !CODEX_CALLBACK_PORTS.includes(port) ||
    callback.pathname !== CODEX_CALLBACK_PATH
  )
    return undefined;
  return { port, path: CODEX_CALLBACK_PATH, state };
}

/** What became of an address a person pasted: the request to make, or why not — never the address. */
export type CodexCallbackCheck =
  | { readonly kind: 'deliver'; readonly delivery: CodexCallbackDelivery }
  | { readonly kind: 'refused'; readonly reason: string };

const refused = (reason: string): CodexCallbackCheck => ({ kind: 'refused', reason });

/**
 * Check a pasted address STRICTLY against the callback Codex printed, and build the one request that
 * delivers it.
 *
 * Every refusal is a sentence about what is wrong with the KIND of thing pasted, so a person can fix it,
 * and none of them quotes it. The query that is delivered is rebuilt from the checked values alone, so
 * nothing the person pasted that was not checked can reach Codex.
 */
export function codexCallbackDelivery(pasted: string, expected: CodexCallbackTarget): CodexCallbackCheck {
  const value = pasted.trim();
  if (!URL.canParse(value)) {
    return refused(
      'That is not a web address. Copy the whole address from the browser’s address bar — it starts with http://localhost.',
    );
  }
  const url = new URL(value);
  if (url.protocol === 'https:' && url.pathname.endsWith('/oauth/authorize')) {
    return refused(
      'That is the sign-in link itself. Open it, sign in, then copy the address of the page that fails to load afterwards.',
    );
  }
  if (
    url.protocol !== 'http:' ||
    !CALLBACK_HOSTS.includes(url.hostname) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return refused('That address is not the one Codex is waiting for. It starts with http://localhost.');
  }
  if (Number(url.port) !== expected.port || url.pathname !== expected.path || url.hash !== '') {
    return refused(
      `That address is not the one this sign-in is waiting for. It starts with http://localhost:${expected.port}${expected.path}.`,
    );
  }
  const keys = [...url.searchParams.keys()];
  if (keys.includes('error')) {
    return refused('The provider says that sign-in did not finish. Start a new sign-in and try again.');
  }
  if (keys.some(key => !CALLBACK_KEYS.has(key)) || new Set(keys).size !== keys.length) {
    return refused('That address has parts a Codex sign-in never has. Copy it again, exactly as the browser shows it.');
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (state !== expected.state) {
    return refused(
      'That address belongs to a different sign-in attempt. Use the link on this screen, then paste the address it leads to.',
    );
  }
  if (code === null || !TOKEN_SHAPE.test(code)) {
    return refused(
      'That address has no sign-in code in it. Copy the whole address, including everything after the “?”.',
    );
  }
  const query = new URLSearchParams();
  for (const key of ['code', 'scope', 'state', 'iss']) {
    const kept = url.searchParams.get(key);
    if (kept !== null) query.set(key, kept);
  }
  return { kind: 'deliver', delivery: { port: expected.port, path: expected.path, query: query.toString() } };
}
