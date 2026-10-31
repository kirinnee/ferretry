import { describe, it } from 'bun:test';
import type { AccountUsage } from '@ferretry/protocol';
import should from 'should';
import {
  ApiDispatcher,
  ApiRouter,
  createApiDispatcher,
  daemonApiRoutes,
  healthRoutes,
  NO_GOVERNED_ROUTES_GUARD,
  PROMETHEUS_CONTENT_TYPE,
  type UsageFeedDocument,
  usageRoutes,
} from '../../../src/lib/api/index.ts';
import { type UsageFeedPort, WatchedUsageFeed } from '../../../src/lib/usage/index.ts';
import { daemonVersion } from '../../../src/lib/version.ts';
import { fixedClock, jsonBody, request } from './support.ts';

const NOW = 1_700_000_000_000;

/** A feed under the test's control: no transport, no timers, no collection. */
class StubFeed implements UsageFeedPort {
  reads = 0;
  constructor(
    private readonly answer: readonly AccountUsage[] | Error,
    private readonly at: number | undefined,
  ) {}

  async accounts(): Promise<readonly AccountUsage[]> {
    this.reads += 1;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }

  snapshotAt(): number | undefined {
    return this.at;
  }

  hasSnapshot(): boolean {
    return this.at !== undefined;
  }
}

const dispatch = (feed: UsageFeedPort, path: string) =>
  new ApiDispatcher(
    new ApiRouter([...healthRoutes(fixedClock(NOW), NOW - 90_000), ...usageRoutes(feed, fixedClock(NOW), () => true)]),
    { admin: 'admin-secret', warden: 'warden-secret' },
    NO_GOVERNED_ROUTES_GUARD,
  ).dispatch(request({ path }));

describe('health routes', () => {
  it('should answer /healthz without a token', async () => {
    // Arrange
    const feed = new StubFeed([], NOW);

    // Act
    const response = await dispatch(feed, '/healthz');

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({
      status: 'ok',
      version: daemonVersion,
      sessionProtocol: 'ferretry-relay/2',
      uptimeSeconds: 90,
    });
  });

  it('should leave /v1/health to the mount that can answer it', async () => {
    // The protocol declares `/v1/health` as the full `HealthView`, which this table cannot build:
    // it has no session index and no self-check. Answering it here with the liveness body is what
    // made the CLI's schema-parsing probe report a serving daemon as unreachable.
    // Authenticated, because an unknown route is only reported as one to a caller who has already
    // proved itself — an anonymous probe cannot map the surface by watching 404 turn into 405.
    // Arrange
    const dispatcher = new ApiDispatcher(
      new ApiRouter([...healthRoutes(fixedClock(NOW), NOW - 90_000)]),
      {
        admin: 'admin-secret',
        warden: 'warden-secret',
      },
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/health', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(response.status).equal(404);
  });

  it('should not let liveness be cached', async () => {
    // Arrange / Act
    const response = await dispatch(new StubFeed([], NOW), '/healthz');

    // Assert
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should answer liveness without touching any subsystem', async () => {
    // A probe that a slow dependency can fail reports the wrong thing.
    // Arrange
    const feed = new StubFeed(new Error('the upstream is down'), undefined);

    // Act
    const response = await dispatch(feed, '/healthz');

    // Assert
    should(response.status).equal(200);
    should(feed.reads).equal(0);
  });

  it('should never report a negative uptime', async () => {
    // Arrange
    const routes = healthRoutes(fixedClock(NOW), NOW + 10_000);

    // Act
    const response = await routes[0]!.handle({ request: request(), params: new Map() });

    // Assert
    should(jsonBody(response).uptimeSeconds).equal(0);
  });

  it('should add the boot step, the pid and the loop lag once a boot supplies them', async () => {
    // Arrange — a boot that is serving every route and still arming its background loops.
    const routes = healthRoutes(fixedClock(NOW), NOW - 30_000, {
      pid: 4242,
      boot: () => ({ phase: 'finishing', step: 'arming the warden', stepElapsedMs: 1_200, bootElapsedMs: 30_000 }),
      loop: () => ({ lagMs: 4, maxLagMs: 4, stalls: 0 }),
    });

    // Act
    const response = await routes[0]!.handle({ request: request(), params: new Map() });

    // Assert — status is `ok` from the moment routes are served; the boot block says what is left.
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({
      status: 'ok',
      version: daemonVersion,
      sessionProtocol: 'ferretry-relay/2',
      uptimeSeconds: 30,
      pid: 4242,
      boot: { phase: 'finishing', step: 'arming the warden', stepElapsedSeconds: 1, elapsedSeconds: 30 },
      eventLoop: { lagMs: 4, maxLagMs: 4, stalls: 0 },
    });
  });

  it('should answer a still-starting boot with a 503 carrying the whole liveness body', async () => {
    // Arrange
    const routes = healthRoutes(fixedClock(NOW), NOW, {
      pid: 4242,
      boot: () => ({ phase: 'starting', step: 'mounting subsystems', stepElapsedMs: 0, bootElapsedMs: 0 }),
      loop: () => ({ lagMs: 0, maxLagMs: 0, stalls: 0 }),
    });

    // Act
    const response = await routes[0]!.handle({ request: request(), params: new Map() });

    // Assert
    should(response.status).equal(503);
    should(jsonBody(response).status).equal('starting');
    should(response.headers.get('cache-control')).equal('no-store');
  });
});

describe('the usage feed', () => {
  const account: AccountUsage = { agent: 'auto-loge', provider: 'anthropic', ok: true, fiveHourPercent: 10 };

  it('should serve the {at, accounts} document external consumers already parse', async () => {
    // Arrange
    const feed = new StubFeed([account], NOW - 1_000);

    // Act
    const response = await dispatch(feed, '/usage');

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response) as unknown as UsageFeedDocument).deepEqual({
      at: NOW - 1_000,
      ready: true,
      accounts: [account],
    });
  });

  it('should distinguish "never collected" from "the fleet is empty"', async () => {
    // The source answered {at: 0, accounts: []} for both, which is why its one hard gate on this
    // feed could not tell them apart and chose to fail open.
    // Arrange
    const empty = new StubFeed([], NOW);
    const never = new StubFeed([], undefined);

    // Act
    const emptyFleet = jsonBody(await dispatch(empty, '/usage'));
    const noCollection = jsonBody(await dispatch(never, '/usage'));

    // Assert
    should(emptyFleet).deepEqual({ at: NOW, ready: true, accounts: [] });
    should(noCollection).deepEqual({ at: 0, ready: false, accounts: [] });
  });

  it('should degrade to not-ready rather than failing when a collection throws', async () => {
    // Arrange
    const feed = new StubFeed(new Error('the collector refused the connection'), NOW);

    // Act
    const response = await dispatch(feed, '/usage');

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).ready).be.false();
  });

  it('should serve /usage without a token and /v1/usage only with one', async () => {
    // Arrange
    const feed = new StubFeed([account], NOW);

    // Act
    const publicFeed = await dispatch(feed, '/usage');
    const versioned = await dispatch(feed, '/v1/usage');

    // Assert
    should(publicFeed.status).equal(200);
    should(versioned.status).equal(401);
  });

  it('should serve /v1/usage to an authenticated caller', async () => {
    // Arrange
    const feed = new StubFeed([account], NOW);
    const dispatcher = new ApiDispatcher(
      new ApiRouter([...usageRoutes(feed, fixedClock(NOW), () => true)]),
      {
        admin: 'admin-secret',
      },
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/usage', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ at: new Date(NOW).toISOString(), stale: false, accounts: [account] });
  });

  it('should tell a protocol client when no usage snapshot has ever been collected', async () => {
    // Arrange
    const dispatcher = new ApiDispatcher(
      new ApiRouter([...usageRoutes(new StubFeed([], undefined), fixedClock(NOW), () => true)]),
      {
        admin: 'admin-secret',
      },
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/usage', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(jsonBody(response)).deepEqual({ stale: true, accounts: [] });
  });

  it('should never let a machine feed be cached', async () => {
    // Arrange
    const feed = new StubFeed([account], NOW);

    // Act
    const response = await dispatch(feed, '/usage');

    // Assert
    should(response.headers.get('cache-control')).equal('no-store');
  });
});

describe('the metrics endpoint', () => {
  it('should serve Prometheus text, unauthenticated, in the negotiated version', async () => {
    // Arrange
    const feed = new StubFeed([{ agent: 'auto-loge', provider: 'anthropic', usageBased: true }], NOW);

    // Act
    const response = await dispatch(feed, '/metrics');

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('content-type')).equal(PROMETHEUS_CONTENT_TYPE);
    should(response.body).containEql('ferretry_account_usage_based{agent="auto-loge",provider="anthropic"} 1');
  });

  it('should read only what the feed already holds — a scrape must never cost a probe', async () => {
    // Arrange
    const feed = new StubFeed([], NOW);

    // Act
    await dispatch(feed, '/metrics');
    await dispatch(feed, '/metrics');

    // Assert: the cached feed decides when to collect; the endpoint only ever asks it for the view.
    should(feed.reads).equal(2);
  });

  it('should report a not-ready feed rather than failing the scrape', async () => {
    // Arrange
    const feed = new StubFeed(new Error('the upstream timed out'), NOW);

    // Act
    const response = await dispatch(feed, '/metrics');

    // Assert
    should(response.status).equal(200);
    should(response.body).containEql('ferretry_usage_feed_ready 0');
  });
});

describe('the assembled daemon surface', () => {
  const dependencies = {
    credentials: { admin: 'admin-secret' },
    usage: new StubFeed([], NOW),
    clock: fixedClock(NOW),
    startedAtMs: NOW,
    publicUsageFeed: () => true,
  };

  it('should mount every contract the daemon promises', () => {
    // Arrange / Act
    const paths = daemonApiRoutes(dependencies).map(route => `${route.method} ${route.path}`);

    // Assert
    should(paths).deepEqual(['GET /healthz', 'GET /usage', 'GET /v1/usage', 'GET /metrics']);
  });

  it('should build a dispatcher that serves them', async () => {
    // Arrange
    const dispatcher = createApiDispatcher(dependencies);

    // Act
    const response = await dispatcher.dispatch(request({ path: '/metrics' }));

    // Assert
    should(response.status).equal(200);
    should(response.body).containEql('ferretry_accounts_total 0');
  });
});

describe('usage routes — who is a watcher (docs/provider-quotas.md)', () => {
  it('should let only /v1/usage ask for provider quotas; the scraped /usage and /metrics read the cache', async () => {
    // Arrange
    let watches = 0;
    const feed = new WatchedUsageFeed(new StubFeed([{ agent: 'glm', ok: true }], NOW), () => ({
      watch: async () => {
        watches += 1;
      },
      peekAgent: () => undefined,
    }));
    const dispatcher = new ApiDispatcher(
      new ApiRouter([...usageRoutes(feed, fixedClock(NOW), () => true)]),
      { admin: 'admin-secret' },
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    await dispatcher.dispatch(request({ path: '/usage' }));
    await dispatcher.dispatch(request({ path: '/metrics' }));
    const scraped = watches;
    await dispatcher.dispatch(request({ path: '/v1/usage', headers: { authorization: 'Bearer admin-secret' } }));

    // Assert
    should(scraped).equal(0);
    should(watches).equal(1);
  });
});

describe('usage routes — the public pair is opt-in (docs/multi-user-host.md)', () => {
  const dispatcherWith = (publicFeed: () => boolean) =>
    new ApiDispatcher(
      new ApiRouter([...usageRoutes(new StubFeed([{ agent: 'glm', ok: true }], NOW), fixedClock(NOW), publicFeed)]),
      { admin: 'admin-secret' },
      NO_GOVERNED_ROUTES_GUARD,
    );
  const AUTHENTICATED = { authorization: 'Bearer admin-secret' };

  it.each(['/usage', '/metrics'])('should serve %s to anyone while the owner has the feed on', async path => {
    // Act
    const response = await dispatcherWith(() => true).dispatch(request({ path }));

    // Assert
    should(response.status).equal(200);
  });

  it.each(['/usage', '/metrics'])(
    'should answer %s exactly as it answers a path that does not exist, for anyone, while the feed is off',
    async path => {
      // Arrange
      const dispatcher = dispatcherWith(() => false);
      const unrouted = '/not-a-route';

      // Act
      const anonymous = await dispatcher.dispatch(request({ path }));
      const anonymousUnrouted = await dispatcher.dispatch(request({ path: unrouted }));
      const authenticated = await dispatcher.dispatch(request({ path, headers: AUTHENTICATED }));
      const authenticatedUnrouted = await dispatcher.dispatch(request({ path: unrouted, headers: AUTHENTICATED }));

      // Assert — a handler-level 404 would give an anonymous caller 404 where an unrouted path gives 401.
      should(anonymous.status).equal(401);
      should(anonymous).deepEqual({ ...anonymousUnrouted, body: anonymous.body });
      should(authenticated.status).equal(404);
      should(authenticated).deepEqual({ ...authenticatedUnrouted, body: authenticated.body });
    },
  );

  it('should not name the pair in a 405 either: a verb the route never had is a 404 while the feed is off', async () => {
    // Act
    const response = await dispatcherWith(() => false).dispatch(
      request({ method: 'POST', path: '/usage', headers: AUTHENTICATED }),
    );

    // Assert
    should(response.status).equal(404);
  });

  it('should leave /v1/usage token-scoped and served whether the feed is on or off', async () => {
    // Act
    const off = await dispatcherWith(() => false).dispatch(request({ path: '/v1/usage', headers: AUTHENTICATED }));
    const anonymous = await dispatcherWith(() => false).dispatch(request({ path: '/v1/usage' }));

    // Assert
    should(off.status).equal(200);
    should(anonymous.status).equal(401);
  });

  it('should follow the switch at every request, not at the moment the routes were built', async () => {
    // Arrange
    let on = false;
    const dispatcher = dispatcherWith(() => on);

    // Act
    const before = await dispatcher.dispatch(request({ path: '/usage' }));
    on = true;
    const during = await dispatcher.dispatch(request({ path: '/usage' }));
    on = false;
    const after = await dispatcher.dispatch(request({ path: '/usage' }));

    // Assert
    should([before.status, during.status, after.status]).deepEqual([401, 200, 401]);
  });
});
