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
  type QuotaFetch,
  type QuotaRequest,
  type QuotaResponse,
} from '../../src/adapters/anthropic-usage-probe.ts';
import type { CredentialMaterial } from '../../src/lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../../src/lib/manifest.ts';

const TOKEN = 'placeholder-access-token';

const account = (overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount => ({
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
  /** Set to make `json()` reject, as an HTML error page would. */
  readonly unreadableJson?: boolean;
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
    const response: QuotaResponse = {
      status,
      ok: reply.ok ?? (status >= 200 && status < 300),
      header: name => reply.headers?.[name.toLowerCase()] ?? null,
      json:
        reply.unreadableJson === true
          ? () => Promise.reject(new Error('Unexpected token < in JSON'))
          : () => Promise.resolve(reply.body),
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

  it('should condemn the credential on a 401 and mark the account unavailable', async () => {
    // Arrange
    const { fetch } = transport({ [ANTHROPIC_USAGE_URL]: { status: 401 } });

    // Act
    const actual = await new AnthropicUsageProbe({ fetch, credentials: storedCredential }).probe(account());

    // Assert
    should(actual.ok).be.false();
    should(actual.authOk).be.false();
    should(actual.unavailable).be.true();
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
  const forbidden = () => transport({ [ANTHROPIC_USAGE_URL]: { status: 403 } });

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
    should(await actual.json()).deepEqual({ five_hour: { utilization: 42 } });
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
});
