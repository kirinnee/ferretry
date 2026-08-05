import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import { daemonConnection } from '../../../bin/fy.ts';
import { ProtocolFleetAuthorizationGateway } from '../../../src/lib/fleet/gateway.ts';

/**
 * `fy fleet authorize` against a disposable daemon, through the REAL discovery the composition root
 * uses.
 *
 * The unit tests drive the gateway with a fake client, which proves the shape it sends and nothing
 * about where it sends it. This tier answers the question that actually matters for a host-scoped
 * route: does the credential this command carries come from the daemon the environment selected?
 * So nothing here is stubbed below `daemonConnection` — the state home, the recorded address, the
 * owner-only token file and the bearer on the wire are all the production ones.
 *
 * Every daemon here is a throwaway `Bun.serve` on a loopback port inside a temp directory. No live
 * fleet, no live daemon and no real credential is touched.
 */

const PROPOSAL_ID = 'fy_fprop_7Zq3Kd91Lm4Rt8Vx2Ns6Bc';

interface Received {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

interface FakeDaemon {
  readonly url: string;
  readonly received: Received[];
  stop(): void;
}

function mint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: PROPOSAL_ID,
    code: '7F3K-M9QW',
    ttlSeconds: 120,
    expiresAt: '2026-08-05T12:34:56.000Z',
    maxAttempts: 5,
    mutation: 'create-account',
    summary: 'add claude-auto-loge',
    ...overrides,
  };
}

/** A daemon that records what reached it and answers with whatever the test told it to. */
function fakeDaemon(respond: (request: Received) => Response): FakeDaemon {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async request => {
      const url = new URL(request.url);
      const entry: Received = {
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        body: await request.text(),
      };
      received.push(entry);
      return respond(entry);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    received,
    stop: () => server.stop(true),
  };
}

const minted = (): Response =>
  new Response(JSON.stringify(mint()), { status: 200, headers: { 'content-type': 'application/json' } });

/** A state home shaped the way `fyd` leaves one: a recorded address and an owner-only token. */
async function stateHome(root: string, name: string, port: number, token: string): Promise<string> {
  const home = join(root, name);
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port }));
  await writeFile(join(home, 'api-token'), `${token}\n`, { mode: 0o600 });
  return home;
}

async function authorizeVia(
  environment: Record<string, string | undefined>,
  home: string,
  proposalId = PROPOSAL_ID,
): Promise<unknown> {
  const connection = await daemonConnection(environment, home);
  const client = await FyApiClient.connect(connection);
  return await new ProtocolFleetAuthorizationGateway(client).authorize(proposalId);
}

describe('authorizing a fleet proposal against a real daemon connection', () => {
  let root = '';
  let daemon: FakeDaemon | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-fleet-authorize-'));
  });

  afterEach(async () => {
    daemon?.stop();
    daemon = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('should reach the host-scoped route carrying the credential fyd minted for that daemon', async () => {
    // Arrange
    daemon = fakeDaemon(minted);
    const home = await stateHome(root, 'alpha', portOf(daemon), 'alpha-secret');

    // Act
    const actual = (await authorizeVia({ FY_HOME: home }, home)) as { code: string };

    // Assert — the exact route, the exact method, and the owner-only token as the bearer
    should(daemon.received).have.length(1);
    should(daemon.received[0]?.method).equal('POST');
    should(daemon.received[0]?.path).equal(`/v1/fleet/proposals/${PROPOSAL_ID}/authorize`);
    should(daemon.received[0]?.authorization).equal('Bearer alpha-secret');
    should(actual.code).equal('7F3K-M9QW');
  });

  it('should send no request body, because the host route reads none', async () => {
    // Arrange
    daemon = fakeDaemon(minted);
    const home = await stateHome(root, 'alpha', portOf(daemon), 'alpha-secret');

    // Act
    await authorizeVia({ FY_HOME: home }, home);

    // Assert
    should(daemon.received[0]?.body).equal('');
  });

  it('should never put the approval code on the wire it asked over', async () => {
    // Arrange — the code exists only in the response
    daemon = fakeDaemon(minted);
    const home = await stateHome(root, 'alpha', portOf(daemon), 'alpha-secret');

    // Act
    await authorizeVia({ FY_HOME: home }, home);

    // Assert — a path is a URL and a URL reaches an access log
    should(daemon.received[0]?.path).not.containEql('7F3K');
    should(daemon.received[0]?.body).not.containEql('7F3K');
  });

  it('should let FY_HOME choose which local daemon is asked, and with whose credential', async () => {
    // Arrange — two daemons on this machine, each with its own recorded port and its own token
    const alpha = fakeDaemon(minted);
    const beta = fakeDaemon(minted);
    try {
      const homeAlpha = await stateHome(root, 'alpha', portOf(alpha), 'alpha-secret');
      const homeBeta = await stateHome(root, 'beta', portOf(beta), 'beta-secret');

      // Act
      await authorizeVia({ FY_HOME: homeAlpha }, homeAlpha);
      await authorizeVia({ FY_HOME: homeBeta }, homeBeta);

      // Assert — neither daemon saw the other's request, and neither saw the other's token
      should(alpha.received).have.length(1);
      should(beta.received).have.length(1);
      should(alpha.received[0]?.authorization).equal('Bearer alpha-secret');
      should(beta.received[0]?.authorization).equal('Bearer beta-secret');
    } finally {
      alpha.stop();
      beta.stop();
    }
  });

  it('should let FY_URL and FY_TOKEN pin a daemon the state home knows nothing about', async () => {
    // Arrange — the state home points at alpha; the environment pins beta
    const alpha = fakeDaemon(minted);
    const beta = fakeDaemon(minted);
    try {
      const home = await stateHome(root, 'alpha', portOf(alpha), 'alpha-secret');

      // Act
      await authorizeVia({ FY_HOME: home, FY_URL: beta.url, FY_TOKEN: 'pinned-secret' }, home);

      // Assert
      should(alpha.received).be.empty();
      should(beta.received).have.length(1);
      should(beta.received[0]?.authorization).equal('Bearer pinned-secret');
    } finally {
      alpha.stop();
      beta.stop();
    }
  });

  it('should refuse to send a local credential to a daemon that is not on this machine', async () => {
    // Arrange
    const home = await stateHome(root, 'alpha', 1, 'alpha-secret');

    // Act + Assert — no FY_TOKEN, so there is nothing to send that may leave this host
    await should(authorizeVia({ FY_HOME: home, FY_URL: 'https://daemon.example.test' }, home)).be.rejectedWith(
      /never sent remotely/u,
    );
  });

  it('should surface a refused proposal with the reason the daemon gave', async () => {
    // Arrange — the fleet refusal grammar: 409 with a code
    daemon = fakeDaemon(
      () =>
        new Response(
          JSON.stringify({ error: 'fleet proposal expired before it was authorized', code: 'fleet_proposal_expired' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    const home = await stateHome(root, 'alpha', portOf(daemon), 'alpha-secret');

    // Act + Assert — an expired proposal must not read as a mistyped id
    await should(authorizeVia({ FY_HOME: home }, home)).be.rejectedWith(/expired/u);
  });

  it('should surface a forbidden credential rather than pretending it minted something', async () => {
    // Arrange — what the dispatcher answers a device or a warden on a host-scoped route
    daemon = fakeDaemon(
      () =>
        new Response(JSON.stringify({ error: 'forbidden', code: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const home = await stateHome(root, 'alpha', portOf(daemon), 'alpha-secret');

    // Act + Assert
    await should(authorizeVia({ FY_HOME: home }, home)).be.rejected();
  });

  it('should refuse a mint whose shape is not the contract, rather than render it half-parsed', async () => {
    // Arrange — a daemon that answered 200 with a body missing the expiry
    const { expiresAt: _dropped, ...incomplete } = mint();
    daemon = fakeDaemon(
      () => new Response(JSON.stringify(incomplete), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const home = await stateHome(root, 'alpha', portOf(daemon), 'alpha-secret');

    // Act + Assert
    await should(authorizeVia({ FY_HOME: home }, home)).be.rejected();
  });

  it('should ask about an id it does not itself validate, exactly as given', async () => {
    // Arrange — the protocol parses the id a mint ECHOES, but the id a caller ASKS about stays an
    // opaque handle: an older `fy` must not refuse to carry a question a newer daemon can answer.
    daemon = fakeDaemon(minted);
    const home = await stateHome(root, 'alpha', portOf(daemon), 'alpha-secret');

    // Act
    await authorizeVia({ FY_HOME: home }, home, 'fprop_some_later_grammar');

    // Assert
    should(daemon.received[0]?.path).equal('/v1/fleet/proposals/fprop_some_later_grammar/authorize');
  });
});

function portOf(daemon: FakeDaemon): number {
  return Number(new URL(daemon.url).port);
}
