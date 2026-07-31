import { describe, it } from 'bun:test';
import should from 'should';
import { withE2eEnvironment } from './fixture';

/**
 * Journeys for the attention, pin and analytics command groups.
 *
 * The shipped binary is driven against a stub daemon on an ephemeral loopback port — never a real
 * `fyd`, never a real state home. What this proves is what unit tests cannot: the composition root
 * actually constructs these controllers, the protocol client reaches the routes they name, and the
 * rendered output survives a real HTTP round trip.
 */

const SESSION = 'e2e-session';

const PIN_ID = '11111111-1111-4111-8111-111111111111';

const pinBoard = {
  v: 1,
  sessionId: SESSION,
  pins: [
    {
      id: PIN_ID,
      at: 4,
      kind: 'note',
      text: 'rebase before pushing',
      by: 'human',
      createdBy: null,
      createdByName: null,
    },
  ],
  updatedAt: '2026-07-31T09:00:00.000Z',
};

const attentionBoard = {
  v: 1,
  sessionId: SESSION,
  items: [
    {
      id: 'A1',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'approve the deploy',
      why: 'the release is blocked on it',
      howToResolve: 'approve or reject on the board',
      waitingSince: '2026-07-31T09:00:00.000Z',
      ask: { kind: 'permission' },
      raisedBy: 'agent',
      raisedBySession: 'agent-session',
      raisedByName: 'sol',
    },
  ],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-07-31T09:00:00.000Z',
};

const analyticsFeed = {
  kind: 'aggregate',
  query: 'sum(tokens) by agent',
  parsed: { aggregation: 'sum', groupBy: ['agent'], matchers: [] },
  scope: { allSessions: true, indexed: 2, matched: 2 },
  index: {
    schemaVersion: 1,
    sessions: 2,
    tokenSessions: 2,
    transcriptSources: 1,
    indexedTranscriptSources: 1,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  aggregation: 'sum',
  results: [
    {
      labels: { agent: 'sol' },
      sessions: 2,
      rates: { stall: 0, failure: 0, completion: 100 },
      tokens: { value: 2_000_000, known: 2, total: 2 },
      inputTokens: { value: 1_500_000, known: 2, total: 2 },
      outputTokens: { value: 500_000, known: 2, total: 2 },
      cachedInputTokens: { value: 0, known: 2, total: 2 },
      cacheWriteInputTokens: { value: 0, known: 2, total: 2 },
      cacheWrite5mInputTokens: { value: 0, known: 2, total: 2 },
      cacheWrite1hInputTokens: { value: 0, known: 2, total: 2 },
      equivalentApiCostUsdMicros: { value: 7_250_000, known: 2, total: 2 },
      turns: { value: 30, known: 2, total: 2 },
      durationMs: { value: 120_000, known: 2, total: 2 },
      timeToFirstOutputMs: { value: 500, known: 2, total: 2 },
      contextEndPercent: { value: 50, known: 2, total: 2 },
    },
  ],
};

interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

interface Stub {
  readonly requests: StubRequest[];
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** A stub daemon on an OS-assigned ephemeral port: enough of the wire for these journeys, nothing more. */
async function startStubDaemon(): Promise<Stub> {
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json() : undefined;
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        body,
      });
      const payload = route(url.pathname);
      const status = payload === undefined ? 404 : 200;
      return Response.json(payload ?? { error: 'no such route', code: 'unknown_route', path: url.pathname }, {
        status,
        headers: { 'x-fy-version': request.headers.get('x-fy-version') ?? '0.0.0' },
      });
    },
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function route(path: string): unknown {
  if (path === `/v1/sessions/${SESSION}/pins`) return pinBoard;
  if (path === `/v1/sessions/${SESSION}/attention`) return attentionBoard;
  if (path === `/v1/sessions/${SESSION}/notify`) return { sessionId: SESSION, delivered: 2 };
  if (path === '/v1/analytics') return analyticsFeed;
  return undefined;
}

function connection(stub: Stub): Record<string, string> {
  return {
    FY_URL: stub.baseUrl,
    FY_TOKEN: 'e2e-token',
    FY_SESSION_ID: SESSION,
  };
}

describe('command group journeys', () => {
  it('should list a pin board through the shipped binary', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = await startStubDaemon();

      try {
        // Act
        const actual = await environment.runFy(['pin', 'ls'], connection(stub));

        // Assert
        should(actual.code).equal(0);
        should(actual.out).containEql(`1 pin in ${SESSION}`);
        should(actual.out).containEql('rebase before pushing');
        should(stub.requests[0]?.path).equal(`/v1/sessions/${SESSION}/pins`);
        should(stub.requests[0]?.authorization).equal('Bearer e2e-token');
      } finally {
        await stub.stop();
      }
    });
  });

  it('should remove a pin named by the short id the listing printed', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = await startStubDaemon();

      try {
        // Act
        const actual = await environment.runFy(['pin', 'rm', '11111111'], connection(stub));

        // Assert — the daemon receives the full uuid the CLI resolved from the printed prefix.
        should(actual.code).equal(0);
        should(stub.requests.at(-1)?.body).deepEqual({ action: 'remove', id: PIN_ID });
      } finally {
        await stub.stop();
      }
    });
  });

  it('should raise and answer an attention item through the shipped binary', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = await startStubDaemon();

      try {
        // Act
        const listed = await environment.runFy(['attention', 'ls'], connection(stub));
        const answered = await environment.runFy(['attention', 'done', '!A1', '--approve'], connection(stub));

        // Assert
        should(listed.code).equal(0);
        should(listed.out).containEql('!A1  [agent-raised]  approve the deploy');
        should(listed.out).containEql('answer: approve or reject');
        should(answered.code).equal(0);
        should(stub.requests.at(-1)?.body).deepEqual({
          action: 'resolve',
          id: 'A1',
          response: { kind: 'permission', decision: 'approve' },
        });
      } finally {
        await stub.stop();
      }
    });
  });

  it('should push a notification through the shipped binary', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = await startStubDaemon();

      try {
        // Act
        const actual = await environment.runFy(
          ['attention', 'notify', 'the', 'build', 'is', 'green'],
          connection(stub),
        );

        // Assert
        should(actual.code).equal(0);
        should(actual.out).containEql('notification sent to 2 devices');
        should(stub.requests.at(-1)?.path).equal(`/v1/sessions/${SESSION}/notify`);
      } finally {
        await stub.stop();
      }
    });
  });

  it('should render an analytics table through the shipped binary', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = await startStubDaemon();

      try {
        // Act
        const actual = await environment.runFy(['analytics', 'sum(tokens)', 'by', 'agent'], connection(stub));

        // Assert
        should(actual.code).equal(0);
        should(actual.out).containEql('All sessions: 2 indexed, 2 matched');
        should(actual.out).containEql('EQUIV API COST');
        should(actual.out).containEql('$7.250');
        should(actual.out).containEql('a comparison, not a bill');
        should(stub.requests[0]?.path).equal('/v1/analytics');
      } finally {
        await stub.stop();
      }
    });
  });

  it('should emit machine-readable output under --json', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = await startStubDaemon();

      try {
        // Act
        const actual = await environment.runFy(['pin', 'ls', '--json'], connection(stub));

        // Assert
        should(actual.code).equal(0);
        should(JSON.parse(actual.out)).deepEqual(pinBoard);
      } finally {
        await stub.stop();
      }
    });
  });

  it('should refuse to run without a daemon token instead of guessing one', async () => {
    await withE2eEnvironment(async environment => {
      // Act
      const actual = await environment.runFy(['pin', 'ls'], { FY_SESSION_ID: SESSION, FY_TOKEN: '' });

      // Assert
      should(actual.code).equal(1);
      should(actual.err).containEql('FY_TOKEN is not set');
    });
  });

  it('should ask for a session id rather than acting on an unnamed board', async () => {
    await withE2eEnvironment(async environment => {
      // Act
      const actual = await environment.runFy(['attention', 'ls'], { FY_SESSION_ID: '', FY_TOKEN: 'e2e-token' });

      // Assert
      should(actual.code).equal(1);
      should(actual.err).containEql('no session id');
    });
  });

  it('should report an unknown daemon route without a stack trace', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = await startStubDaemon();

      try {
        // Act — a board on another session is not routed by the stub.
        const actual = await environment.runFy(['pin', 'ls', '--session', 'somewhere-else'], connection(stub));

        // Assert
        should(actual.code).equal(1);
        should(actual.err).not.containEql('at <anonymous>');
        should(actual.err).not.be.empty();
      } finally {
        await stub.stop();
      }
    });
  });
});
