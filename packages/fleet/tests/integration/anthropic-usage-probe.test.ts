/**
 * The Anthropic quota probe against a scripted transport.
 *
 * No test makes a network call and none reads a real credential: the fetch and the credential source
 * are both seams. The point of testing it here rather than in the unit tier is that this is the module
 * that decides *which* endpoint to ask and what an HTTP status means — the parsing itself is covered
 * against both scales in `tests/unit/quota.test.ts`.
 */
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import {
  ANTHROPIC_USAGE_URL,
  AnthropicUsageProbe,
  type CredentialMaterialSource,
  fetchQuota,
  MAX_RESPONSE_BODY_BYTES,
  type QuotaFetch,
  type QuotaRequest,
  type QuotaResponse,
} from '../../src/adapters/anthropic-usage-probe.ts';
import type { CredentialMaterial } from '../../src/lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../../src/lib/manifest.ts';

const TOKEN = 'placeholder-access-token';

const account = (overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount => ({
  secretEnv: {},
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'claude',
  mode: 'interactive',
  wrapper: '/fleet/bin/claude-kirin',
  home: '/fleet/homes/one',
  displayName: 'claude-kirin',
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

/** A credential source holding one blob. Never a real keychain or a real file. */
const credentials = (material: CredentialMaterial): CredentialMaterialSource => ({
  material: (_kind: HarnessKind, _home: string) => Promise.resolve(material),
});

const storedCredential = credentials({
  outcome: 'found',
  blob: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 1_900_000_000_000 } }),
});

interface Reply {
  readonly status?: number;
  readonly ok?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Set to return an HTML error page rather than JSON. */
  readonly unreadableJson?: boolean;
  /** Set when the supplied bytes are only the retained prefix of a larger response. */
  readonly bodyTruncated?: boolean;
  /** Set to make the request itself throw. */
  readonly throws?: Error;
}

/** A transport that answers each URL from a table and records what it was asked. */
function transport(replies: Readonly<Record<string, Reply>>): {
  fetch: QuotaFetch;
  requests: QuotaRequest[];
} {
  const requests: QuotaRequest[] = [];
  const fetch: QuotaFetch = request => {
    requests.push(request);
    const reply = replies[request.url];
    if (reply === undefined) return Promise.reject(new Error(`unexpected url ${request.url}`));
    if (reply.throws) return Promise.reject(reply.throws);
    const status = reply.status ?? 200;
    const text =
      reply.unreadableJson === true
        ? '<html>not JSON</html>'
        : reply.body === undefined
          ? ''
          : JSON.stringify(reply.body);
    const encoded = new TextEncoder().encode(text);
    const response: QuotaResponse = {
      status,
      ok: reply.ok ?? (status >= 200 && status < 300),
      headerNames: Object.keys(reply.headers ?? {})
        .map(name => name.toLowerCase())
        .sort(),
      header: name => reply.headers?.[name.toLowerCase()] ?? null,
      body: {
        bytes: encoded.slice(0, MAX_RESPONSE_BODY_BYTES),
        truncated: reply.bodyTruncated === true || encoded.byteLength > MAX_RESPONSE_BODY_BYTES,
      },
    };
    return Promise.resolve(response);
  };
  return { fetch, requests };
}

describe('AnthropicUsageProbe reading the read-only usage endpoint', () => {
  it('should report both windows from the stored usage percentages', async () => {
    // Arrange
    const { fetch } = transport({
      [ANTHROPIC_USAGE_URL]: {
        body: {
          five_hour: { utilization: 42, resets_at: '2027-01-15T09:00:00.000Z' },
          seven_day: { utilization: 11, resets_at: '2027-01-20T09:00:00.000Z' },
        },
      },
    });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert — 42 is read as 42%, which is only correct under the stored-usage rule.
    should(actual.ok).be.true();
    should(actual.provider).equal('anthropic');
    should(actual.usageBased).be.true();
    should(actual.authOk).be.true();
    should(actual.shortWindow?.usedPercent).equal(42);
    should(actual.longWindow?.usedPercent).equal(11);
    should(actual.atLimit).be.false();
  });

  it('should send the bearer token and ask the read-only endpoint first', async () => {
    // Arrange
    const { fetch, requests } = transport({
      [ANTHROPIC_USAGE_URL]: { body: { five_hour: { utilization: 5 } } },
    });

    // Act
    await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert — one request, to the endpoint that consumes no inference quota.
    should(requests).have.length(1);
    should(requests[0]?.url).equal(ANTHROPIC_USAGE_URL);
    should(requests[0]?.method).equal('GET');
    should(requests[0]?.headers.Authorization).equal(`Bearer ${TOKEN}`);
  });

  it('should retain a secret-safe fingerprint without condemning a login on a bare 401', async () => {
    // Arrange
    const { fetch } = transport({
      [ANTHROPIC_USAGE_URL]: {
        status: 401,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'cf-ray': 'edge-ray-123',
          'content-type': 'application/json; charset=utf-8',
          'request-id': 'request-123',
          'retry-after': '60',
          'set-cookie': 'session=must-never-be-stored',
          'www-authenticate': 'Bearer error="invalid_token", error_description="do not persist this message"',
          'x-request-id': TOKEN,
          [TOKEN]: 'a secret may not survive as a header name either',
        },
        body: {
          type: 'error',
          access_token: 'must-never-be-stored',
          error: {
            type: 'authentication_error',
            code: 'invalid_token',
            message: `Bearer ${TOKEN} was rejected`,
          },
        },
      },
    });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert — a bare control-plane 401 cannot tell token rejection from client rejection, so it is
    // retained as evidence but never turned into a login instruction.
    should(actual.ok).be.false();
    should(actual.authOk).be.undefined();
    should(actual.unavailable).be.undefined();
    should(actual.credentialSignal).equal('rejection_unconfirmed');

    const fingerprint = (actual as unknown as { responseFingerprint?: Record<string, unknown> }).responseFingerprint;
    should(fingerprint).be.an.Object();
    const { bodyLength, bodySha256, ...shape } = fingerprint ?? {};
    should(shape).deepEqual({
      status: 401,
      contentType: 'application/json',
      headerNames: [
        'authorization',
        'cf-ray',
        'content-type',
        'request-id',
        'retry-after',
        'set-cookie',
        'www-authenticate',
        'x-request-id',
      ],
      headers: {
        cfRay: 'edge-ray-123',
        requestId: 'request-123',
        retryAfter: '60',
        wwwAuthenticate: { scheme: 'bearer', errorCode: 'invalid_token' },
        xRequestId: '[redacted]',
      },
      json: {
        type: 'object',
        fields: [
          { path: 'access_token', type: 'string' },
          { path: 'error', type: 'object' },
          { path: 'error.code', type: 'string' },
          { path: 'error.message', type: 'string' },
          { path: 'error.type', type: 'string' },
          { path: 'type', type: 'string' },
        ],
        errorType: 'authentication_error',
        errorCode: 'invalid_token',
      },
    });
    should(bodyLength).be.a.Number().and.be.above(0);
    should(bodySha256)
      .be.a.String()
      .and.match(/^[0-9a-f]{64}$/u);
    const serialized = JSON.stringify(fingerprint);
    should(serialized).not.containEql(TOKEN);
    should(serialized).not.containEql('must-never-be-stored');
    should(serialized).not.containEql('do not persist this message');
  });

  it('should cap oversized body evidence and never trust a truncated JSON shape', async () => {
    // Arrange — an edge challenge can be arbitrarily large. Even a prefix that begins like JSON is
    // not a complete provider error and must not turn a 403 into a healthy scope verdict.
    const { fetch } = transport({
      [ANTHROPIC_USAGE_URL]: {
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: {
          type: 'error',
          error: { type: 'permission_error' },
          padding: 'x'.repeat(MAX_RESPONSE_BODY_BYTES),
        },
      },
    });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.credentialSignal).equal('inconclusive');
    should(actual.responseFingerprint).containDeep({
      status: 403,
      bodyLength: MAX_RESPONSE_BODY_BYTES,
      bodyTruncated: true,
    });
    should(actual.responseFingerprint).not.have.property('json');
  });

  it('should not condemn the credential on a 500, and not mark the account unavailable', async () => {
    // Arrange — a server error says nothing about this account.
    const { fetch } = transport({ [ANTHROPIC_USAGE_URL]: { status: 500 } });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.ok).be.false();
    should(actual.authOk).be.true();
    should(actual.unavailable).be.undefined();
    should(actual)
      .have.property('error')
      .match(/HTTP 500/u);
  });

  it('should report a failure rather than a number when the body carries no measurement', async () => {
    // Arrange — a 200 shaped like an answer, containing none.
    const { fetch } = transport({ [ANTHROPIC_USAGE_URL]: { body: { five_hour: {}, seven_day: {} } } });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert — never a fabricated 0%.
    should(actual.ok).be.false();
    should(actual)
      .have.property('error')
      .match(/no readable quota measurement/u);
    should(actual.shortWindow).be.undefined();
  });

  it('should report unreadable JSON as a failure', async () => {
    // Arrange
    const { fetch } = transport({ [ANTHROPIC_USAGE_URL]: { unreadableJson: true } });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.ok).be.false();
    should(actual)
      .have.property('error')
      .match(/unreadable JSON/u);
  });

  it('should report a transport failure with its own message', async () => {
    // Arrange
    const { fetch } = transport({ [ANTHROPIC_USAGE_URL]: { throws: new Error('getaddrinfo ENOTFOUND') } });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.ok).be.false();
    should(actual.error).equal('getaddrinfo ENOTFOUND');
  });

  it('should name a timeout as a timeout', async () => {
    // Arrange
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    const { fetch } = transport({ [ANTHROPIC_USAGE_URL]: { throws: aborted } });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.error).equal('the request timed out');
  });

  it('should fall back to a stated failure when a transport throws something that is not an error', async () => {
    // Arrange
    const fetch: QuotaFetch = () => Promise.reject('nope');

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.error).equal('the request failed');
  });
});

describe('AnthropicUsageProbe when the usage endpoint refuses the token', () => {
  /**
   * A 403 means the token lacks `user:profile`, which is permanent for an inference-scoped token.
   *
   * This block used to assert the OPPOSITE: that the probe then sent `POST /v1/messages` and read the
   * quota from its headers. That is a real billable turn, and the daemon's unattended refresh reaches
   * this probe on a fixed timer — so those tests pinned an unasked-for spend loop as correct behaviour
   * and stayed green while it shipped. The account is now reported as unmeasurable, which is true and
   * costs nothing, and these tests assert the REQUESTS MADE rather than a flag, so a fallback cannot
   * return without turning them red.
   */
  const forbidden = () =>
    transport({
      [ANTHROPIC_USAGE_URL]: {
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: {
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'OAuth token does not meet scope requirement user:profile',
          },
        },
      },
    });

  it('should report the account as unmeasurable rather than buying the number', async () => {
    // Arrange
    const { fetch } = forbidden();

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert — not measurable, and NOT signed out: the token still works, it just cannot read usage.
    should(actual.ok).be.false();
    should(actual.authOk).be.true();
    should(actual.error ?? '').match(/user:profile/u);
  });

  it('should make exactly one request, and never a POST', async () => {
    // Arrange
    const { fetch, requests } = forbidden();

    // Act
    await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert — the whole request list, so an added call is a failure rather than an unnoticed cost.
    should(requests.map(request => request.url)).deepEqual([ANTHROPIC_USAGE_URL]);
    should(requests.map(request => request.method)).deepEqual(['GET']);
  });

  it('should not mistake a Cloudflare HTML challenge for an accepted scope-limited token', async () => {
    // Arrange — the status is the same 403, but the response came from the edge rather than the
    // Anthropic JSON API. Status-only classification would publish a false green account.
    const { fetch } = transport({
      [ANTHROPIC_USAGE_URL]: {
        status: 403,
        headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html; charset=UTF-8' },
        unreadableJson: true,
      },
    });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.credentialSignal).equal('inconclusive');
    const fingerprint = (actual as unknown as { responseFingerprint?: Record<string, unknown> }).responseFingerprint;
    should(fingerprint).containDeep({
      status: 403,
      contentType: 'text/html',
      headers: { cfMitigated: 'challenge' },
    });
    should(fingerprint).not.have.property('json');
  });

  it('should not mistake an Anthropic-shaped authentication 403 for a scope failure', async () => {
    // Arrange — JSON and an error object establish the origin, but only `permission_error` confirms
    // this endpoint's accepted-but-unmeasurable scope response.
    const { fetch } = transport({
      [ANTHROPIC_USAGE_URL]: {
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: { type: 'error', error: { type: 'authentication_error', message: 'not retained' } },
      },
    });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.credentialSignal).equal('inconclusive');
  });
});

describe('AnthropicUsageProbe when there is nothing to ask with', () => {
  it('should refuse an account with no stored credential, and say the auth is bad', async () => {
    // Arrange
    const { fetch, requests } = transport({});

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: credentials({ outcome: 'absent' }) }).probe(
      account(),
    );

    // Assert — nothing was asked, and no number was invented.
    should(requests).deepEqual([]);
    should(actual.ok).be.false();
    should(actual.authOk).be.false();
    should(actual)
      .have.property('error')
      .match(/no readable access token/u);
  });

  it('should refuse a credential whose bytes are not readable JSON', async () => {
    // Arrange
    const { fetch } = transport({});

    // Act
    const actual = await new AnthropicUsageProbe({
      fetch,
      credentials: credentials({ outcome: 'found', blob: 'not json' }),
    }).probe(account());

    // Assert
    should(actual.authOk).be.false();
  });

  it('should refuse a credential that parses but holds no access token', async () => {
    // Arrange
    const { fetch } = transport({});

    // Act
    const actual = await new AnthropicUsageProbe({
      fetch,
      credentials: credentials({ outcome: 'found', blob: JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }) }),
    }).probe(account());

    // Assert
    should(actual.authOk).be.false();
  });

  it('should read a flat credential as well as a nested one', async () => {
    // Arrange
    const { fetch, requests } = transport({
      [ANTHROPIC_USAGE_URL]: { body: { five_hour: { utilization: 7 } } },
    });

    // Act
    const actual = await new AnthropicUsageProbe({
      fetch,
      credentials: credentials({ outcome: 'found', blob: JSON.stringify({ accessToken: TOKEN }) }),
    }).probe(account());

    // Assert
    should(actual.ok).be.true();
    should(requests[0]?.headers.Authorization).equal(`Bearer ${TOKEN}`);
  });

  it('should decline a Codex account rather than asking Anthropic about it', async () => {
    // Arrange — Codex quota is a declared GAP; answering would be inventing a number.
    const { fetch, requests } = transport({});

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(
      account({ kind: 'codex' }),
    );

    // Assert
    should(requests).deepEqual([]);
    should(actual.ok).be.false();
    should(actual.usageBased).be.false();
    should(actual)
      .have.property('error')
      .match(/no Anthropic quota probe applies to a codex account/u);
  });

  it('should honour a supplied timeout', async () => {
    // Arrange
    const { fetch, requests } = transport({
      [ANTHROPIC_USAGE_URL]: { body: { five_hour: { utilization: 1 } } },
    });

    // Act
    await new AnthropicUsageProbe({ fetch, credentials: storedCredential, timeoutMs: 1234 }).probe(account());

    // Assert
    should(requests[0]?.timeoutMs).equal(1234);
  });

  it('should use a default timeout when none is supplied', async () => {
    // Arrange
    const { fetch, requests } = transport({
      [ANTHROPIC_USAGE_URL]: { body: { five_hour: { utilization: 1 } } },
    });

    // Act
    await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(requests[0]?.timeoutMs).be.above(0);
  });
});

/**
 * The shipped transport, against a server this test starts on an ephemeral port.
 *
 * Nothing here reaches the internet and no known port is bound: `port: 0` lets the kernel choose, and
 * the server is stopped in `afterEach`. This is the only way to exercise the real `fetch` wrapper — the
 * status, the header lookup, the JSON read and the deadline.
 */
describe('fetchQuota', () => {
  const servers: Array<{ stop: () => void }> = [];

  const serve = (handler: (request: Request) => Response | Promise<Response>): string => {
    const server = Bun.serve({ port: 0, fetch: handler });
    servers.push({ stop: () => server.stop(true) });
    return `http://127.0.0.1:${server.port}`;
  };

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  it('should report the status, headers and JSON of a real response', async () => {
    // Arrange
    const url = serve(
      () =>
        new Response(JSON.stringify({ five_hour: { utilization: 42 } }), {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.42', 'content-type': 'application/json' },
        }),
    );

    // Act
    const actual = await fetchQuota({
      url,
      method: 'GET',
      headers: { Authorization: 'Bearer placeholder' },
      timeoutMs: 5_000,
    });

    // Assert
    should(actual.status).equal(200);
    should(actual.ok).be.true();
    should(actual.header('anthropic-ratelimit-unified-5h-utilization')).equal('0.42');
    should(actual.header('absent-header')).be.null();
    should(actual.headerNames).containDeep(['anthropic-ratelimit-unified-5h-utilization', 'content-type']);
    should(actual.headerNames).deepEqual([...actual.headerNames].sort());
    should(actual.body.truncated).be.false();
    should(JSON.parse(new TextDecoder().decode(actual.body.bytes))).deepEqual({ five_hour: { utilization: 42 } });
  });

  it('should report a non-2xx status without throwing', async () => {
    // Arrange
    const url = serve(() => new Response('nope', { status: 403 }));

    // Act
    const actual = await fetchQuota({ url, method: 'GET', headers: {}, timeoutMs: 5_000 });

    // Assert
    should(actual.status).equal(403);
    should(actual.ok).be.false();
  });

  it('should cancel and mark a response body at the diagnostic byte limit', async () => {
    // Arrange
    const url = serve(() => new Response('x'.repeat(MAX_RESPONSE_BODY_BYTES + 1_024)));

    // Act
    const actual = await fetchQuota({ url, method: 'GET', headers: {}, timeoutMs: 5_000 });

    // Assert
    should(actual.body.bytes.byteLength).equal(MAX_RESPONSE_BODY_BYTES);
    should(actual.body.truncated).be.true();
  });

  it('should send the headers it was given and no body at all', async () => {
    // Arrange — what a REAL server saw, which is the only witness that matters here. Narrowing
    // `QuotaRequest` makes a payload unrepresentable in the type; this proves the transport under
    // that type sends none, so the two halves of the claim are checked by different means.
    let seen: { method: string; auth: string | null; body: string; contentType: string | null } | undefined;
    const url = serve(async request => {
      seen = {
        method: request.method,
        auth: request.headers.get('authorization'),
        body: await request.text(),
        contentType: request.headers.get('content-type'),
      };
      return new Response('{}', { status: 200 });
    });

    // Act
    await fetchQuota({
      url,
      method: 'GET',
      headers: { Authorization: 'Bearer placeholder' },
      timeoutMs: 5_000,
    });

    // Assert
    should(seen?.method).equal('GET');
    should(seen?.auth).equal('Bearer placeholder');
    should(seen?.body).equal('');
    should(seen?.contentType).be.null();
  });

  it('should abort a response that outlives its deadline', async () => {
    // Arrange — an unbounded probe would hang the whole usage command.
    const url = serve(async () => {
      await Bun.sleep(3_000);
      return new Response('{}');
    });

    // Act / Assert — the abort surfaces as a rejection, which the probe turns into "timed out".
    await fetchQuota({ url, method: 'GET', headers: {}, timeoutMs: 60 }).should.be.rejected();
  });

  it('should keep the deadline armed while reading the response body', async () => {
    // Arrange — headers arrive immediately, then the body never finishes. Clearing the timer after
    // `fetch()` resolves would leave this probe hung forever.
    const url = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: controller => controller.enqueue(new TextEncoder().encode('{')),
          }),
        ),
    );

    // Act / Assert
    await fetchQuota({ url, method: 'GET', headers: {}, timeoutMs: 60 }).should.be.rejected();
  });
});

/**
 * `credentialSignal`, which is what a HEALTH verdict is built from.
 *
 * It is a SECOND field beside `authOk` because `authOk` cannot carry this: it answers "is the
 * credential repudiated" and collapses three different answers into `true` — a `200` that accepted the
 * token, a `403` that accepted it and refused to show usage, and a `503` that said nothing at all.
 * Quota does not care which happened; a health verdict is nothing but that distinction.
 *
 * Every case here asserts the signal AND the request list, so the free-GET claim and the
 * classification are checked by different means in the same test.
 */
describe('AnthropicUsageProbe reporting what the answer said about the credential', () => {
  const signalFor = async (reply: Reply) => {
    const { fetch, requests } = transport({ [ANTHROPIC_USAGE_URL]: reply });
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());
    return { signal: actual.credentialSignal, requests };
  };

  it('should classify a 403 as ACCEPTED-but-unmeasurable, which is a healthy verdict', async () => {
    // Arrange / Act
    const actual = await signalFor({
      status: 403,
      headers: { 'content-type': 'application/json' },
      body: { type: 'error', error: { type: 'permission_error', message: 'missing user:profile' } },
    });

    // Assert — the single most consequential line in the whole feature. `rejected` here would send
    // somebody to sign in again, forever, on an account that works perfectly. Still ONE free GET.
    should(actual.signal).equal('scope_unavailable');
    should(actual.requests.map(request => request.method)).deepEqual(['GET']);
  });

  it('should keep a bare 401 inconclusive until token rejection can be distinguished from client rejection', async () => {
    should((await signalFor({ status: 401 })).signal).equal('rejection_unconfirmed');
  });

  it('should classify a successful read as accepted', async () => {
    should((await signalFor({ body: { five_hour: { utilization: 5 } } })).signal).equal('accepted');
  });

  it('should still call the credential accepted when the body was unreadable', async () => {
    // The provider answered FOR THIS TOKEN and then handed back bytes this build cannot read. That is
    // a lost quota number and a working credential, and reading it as unproven would report an
    // account as broken because its usage JSON changed shape.
    should((await signalFor({ unreadableJson: true })).signal).equal('accepted');
  });

  it('should still call the credential accepted when a 200 carried no measurement', async () => {
    should((await signalFor({ body: { five_hour: {}, seven_day: {} } })).signal).equal('accepted');
  });

  it('should refuse to conclude anything from a 500 or a rate limit', async () => {
    // Note `authOk` is `true` for both of these — correctly, for quota. Health may not read that as
    // acceptance, which is precisely why this is a separate field.
    should((await signalFor({ status: 500 })).signal).equal('inconclusive');
    should((await signalFor({ status: 429, ok: false })).signal).equal('inconclusive');
  });

  it('should distinguish a timeout from an unreachable provider', async () => {
    // Arrange
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';

    // Act / Assert — two sentences a reader acts on differently: "the check timed out" versus "the
    // provider could not be reached". Neither is ever a rejection.
    should((await signalFor({ throws: aborted })).signal).equal('timeout');
    should((await signalFor({ throws: new Error('getaddrinfo ENOTFOUND') })).signal).equal('inconclusive');
  });

  it('should say a credential was ABSENT rather than rejected when nothing was asked', async () => {
    // Arrange
    const { fetch, requests } = transport({});

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: credentials({ outcome: 'absent' }) }).probe(
      account(),
    );

    // Assert — nothing was asked, so nothing was refused. The LOCAL classification is the better
    // evidence about why, and the health verdict prefers it.
    should(actual.credentialSignal).equal('absent');
    should(requests).be.empty();
  });

  it('should classify NOTHING for a Codex account, because it has not looked at one', async () => {
    // Arrange
    const { fetch, requests } = transport({});

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(
      account({ kind: 'codex' }),
    );

    // Assert — an ABSENT signal is how the verdict reaches `codex_liveness_unproven` instead of
    // inventing a conclusion from a probe that declined to run. A signal here would be this probe
    // speaking for a provider it never contacted.
    should(actual).not.have.property('credentialSignal');
    should(requests).be.empty();
  });
});
