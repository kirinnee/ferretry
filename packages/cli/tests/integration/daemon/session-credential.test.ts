import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import { FyApiClient, FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { z } from 'zod';
import { type DaemonCredentialOptions, daemonConnection } from '../../../bin/fy.ts';
import { readDaemonToken } from '../../../src/adapters/daemon/api-token.ts';
import {
  DaemonInstanceCache,
  HealthInstanceReader,
  SessionBearerTransport,
} from '../../../src/adapters/daemon/session-credential.ts';

/**
 * RF-3: a ferret's `fy` and MCP server present the ferret's OWN credential (docs/secrets.md § "What a
 * ferret's `fy` presents"). Against a fake daemon on loopback, so each answer — the feature list, a
 * refusal, a restart onto a bind that takes no bearer — is exactly what the case needs.
 */

const BEARER = 'fys_rf3RF3rf3RF3rf3RF3rf3RF3rf3RF3rf3RF3rf3RF3a';
const ADMIN = 'admin-token-from-the-state-home';
const OK = z.object({ ok: z.literal(true) });

interface FakeDaemon {
  readonly url: string;
  /** What `/v1/health` offers right now; a test changes it to stand for a restart. */
  features: string[];
  pid: number;
  /** How `/v1/thing` answers the session bearer. */
  answer: { status: number; code?: string };
  readonly seen: string[];
  healthReads: number;
  stop(): void;
}

function fakeDaemon(): FakeDaemon {
  // One mutable record the server reads on every request, so a test's change is what the daemon says next.
  const daemon = {
    url: '',
    features: [DAEMON_FEATURES.sessionCredential] as string[],
    pid: 4_101,
    answer: { status: 200 } as FakeDaemon['answer'],
    seen: [] as string[],
    healthReads: 0,
    stop: () => {},
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/health') {
        daemon.healthReads += 1;
        return Response.json({ ok: true, pid: daemon.pid, features: daemon.features });
      }
      const authorization = request.headers.get('authorization') ?? '';
      daemon.seen.push(authorization);
      if (authorization === `Bearer ${ADMIN}`) return Response.json({ ok: true });
      if (authorization === `Bearer ${BEARER}` && daemon.answer.status === 200) return Response.json({ ok: true });
      const status = authorization === `Bearer ${BEARER}` ? daemon.answer.status : 401;
      return Response.json({ error: 'refused', code: daemon.answer.code ?? 'unauthorized' }, { status });
    },
  });
  daemon.url = `http://127.0.0.1:${String(server.port)}`;
  daemon.stop = () => void server.stop(true);
  return daemon;
}

describe("a ferret's fy presents its own credential", () => {
  let root = '';
  let daemon: FakeDaemon;
  let adminReads: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-rf3-'));
    // The admin token is THERE and readable: never opening it is the claim, not its absence.
    await writeFile(join(root, 'api-token'), `${ADMIN}\n`, { mode: 0o600 });
    daemon = fakeDaemon();
    adminReads = [];
  });

  afterEach(async () => {
    daemon.stop();
    await rm(root, { recursive: true, force: true });
  });

  /** A spy over the real token reader: the file is opened only through here. */
  const spyOptions = (extra: DaemonCredentialOptions = {}): DaemonCredentialOptions => ({
    readAdminToken: async path => {
      adminReads.push(path);
      return await readDaemonToken(path);
    },
    ...extra,
  });

  const ferret = (extra: Record<string, string> = {}): Record<string, string> => ({
    FY_HOME: root,
    FY_URL: daemon.url,
    FY_SESSION_TOKEN: BEARER,
    ...extra,
  });

  /** One request the way every command group makes it. */
  async function call(connection: Awaited<ReturnType<typeof daemonConnection>>): Promise<unknown> {
    const client = await FyApiClient.connect({
      baseUrl: connection.baseUrl,
      token: connection.token,
      version: connection.version,
      ...(connection.transport === undefined ? {} : { transport: connection.transport }),
    });
    return await client.request('/v1/thing', OK, { method: 'POST', body: '{}' });
  }

  it('should send the bearer and never open api-token when the daemon offers session.credential.1', async () => {
    // Act — no FY_SESSION_ID at all: the credential alone decides (leylani's rule (b)).
    const connection = await daemonConnection(ferret(), root, undefined, spyOptions());
    await call(connection);

    // Assert
    should(connection.credential).equal('session');
    should(daemon.seen).deepEqual([`Bearer ${BEARER}`]);
    should(adminReads).be.empty();
  });

  it('should answer a daemon that does not offer it with the admin token, as before', async () => {
    // Arrange — an older daemon, or one bound where no bearer resolves.
    daemon.features = [];

    // Act
    const connection = await daemonConnection(ferret(), root, undefined, spyOptions());
    await call(connection);

    // Assert
    should(connection.credential).equal('admin');
    should(daemon.seen).deepEqual([`Bearer ${ADMIN}`]);
    should(adminReads).have.length(1);
  });

  for (const refusal of [
    { status: 403, code: 'owner_only' },
    { status: 404, code: 'unknown_route' },
    { status: 500, code: 'internal' },
  ]) {
    it(`should report a ${String(refusal.status)} from a daemon that offers it, never switching to the admin token`, async () => {
      // Arrange
      daemon.answer = refusal;
      const connection = await daemonConnection(ferret(), root, undefined, spyOptions());

      // Act
      const failure = await call(connection).then(
        () => undefined,
        (error: unknown) => error,
      );

      // Assert
      should(failure).be.instanceOf(FyHttpError);
      should((failure as FyHttpError).status).equal(refusal.status);
      should(daemon.seen.every(seen => seen === `Bearer ${BEARER}`)).be.true();
      should(adminReads).be.empty();
    });
  }

  it('should report a 401 when a fresh health read still offers the credential', async () => {
    // Arrange
    daemon.answer = { status: 401, code: 'unauthorized' };
    const connection = await daemonConnection(ferret(), root, undefined, spyOptions());

    // Act
    const failure = await call(connection).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — one re-read, and the refusal is the answer.
    should((failure as FyHttpError).status).equal(401);
    should(daemon.healthReads).equal(2);
    should(daemon.seen).deepEqual([`Bearer ${BEARER}`]);
    should(adminReads).be.empty();
  });

  it('should fall back once when a 401 comes from a daemon that no longer offers the credential', async () => {
    // Arrange — connected while the daemon offered it; it then restarted onto a wildcard bind.
    const notes: string[] = [];
    const connection = await daemonConnection(
      ferret(),
      root,
      undefined,
      spyOptions({ note: line => notes.push(line) }),
    );
    daemon.features = [];
    daemon.pid = 4_102;
    daemon.answer = { status: 401, code: 'unauthorized' };

    // Act
    const answer = await call(connection);

    // Assert
    should(answer).deepEqual({ ok: true });
    should(daemon.seen).deepEqual([`Bearer ${BEARER}`, `Bearer ${ADMIN}`]);
    should(daemon.healthReads).equal(2);
    should(adminReads).have.length(1);
    should(notes).have.length(1);
  });

  it('should never send an unprefixed credential from before RF-1 as a bearer', async () => {
    // Act — the pane's value has no `fys_` prefix, so no daemon resolves it as one.
    const connection = await daemonConnection(
      { FY_HOME: root, FY_URL: daemon.url, FY_SESSION_BOARD_CAPABILITY: 'k3y-from-before-the-prefix' },
      root,
      undefined,
      spyOptions(),
    );
    await call(connection);

    // Assert
    should(connection.credential).equal('admin');
    should(daemon.seen).deepEqual([`Bearer ${ADMIN}`]);
    should(daemon.seen.join('\n')).not.containEql('k3y-from-before-the-prefix');
  });

  it('should use the admin token for --as-owner, without asking the daemon which it takes', async () => {
    // Act
    const connection = await daemonConnection(ferret(), root, undefined, spyOptions({ asOwner: true }));
    await call(connection);

    // Assert
    should(connection.credential).equal('admin');
    should(daemon.seen).deepEqual([`Bearer ${ADMIN}`]);
    should(daemon.healthReads).equal(0);
  });

  it('should keep FY_TOKEN as the explicit override inside a ferret', async () => {
    const connection = await daemonConnection(ferret({ FY_TOKEN: 'script' }), root, undefined, spyOptions());

    should(connection).match({ credential: 'explicit', token: 'script' });
    should(daemon.healthReads).equal(0);
    should(adminReads).be.empty();
  });

  it('should fail, not fall back, when the daemon cannot be asked', async () => {
    // Arrange — nothing listens there any more.
    daemon.stop();

    // Act
    const failure = await daemonConnection(ferret(), root, undefined, spyOptions()).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(Error);
    should(adminReads).be.empty();
  });

  it('should never send the ferret credential to a daemon on another machine', async () => {
    const failure = await daemonConnection(
      ferret({ FY_URL: 'https://daemon.example.test' }),
      root,
      undefined,
      spyOptions(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    should((failure as Error).message).match(/never sent remotely/u);
    should(adminReads).be.empty();
  });

  it('should ask each daemon once per invocation, however many connections it opens', async () => {
    // Arrange
    const instances = new DaemonInstanceCache(
      new HealthInstanceReader(baseUrl => FyApiClient.connect({ baseUrl, token: 'unauthenticated', version: '1.0.0' })),
    );

    // Act
    await daemonConnection(ferret(), root, undefined, spyOptions({ instances }));
    await daemonConnection(ferret(), root, undefined, spyOptions({ instances }));

    // Assert
    should(daemon.healthReads).equal(1);
    should((await instances.facts(daemon.url)).pid).equal(4_101);
  });
});

describe('the session bearer transport', () => {
  const ok = new Response('{}', { status: 200 });

  it('should leave a 401 to some other credential alone', async () => {
    // Arrange
    let rereads = 0;
    const transport = new SessionBearerTransport({ send: async () => new Response('{}', { status: 401 }) }, BEARER, {
      reread: async () => {
        rereads += 1;
        return { pid: 1, features: [] };
      },
      adminToken: async () => ADMIN,
    });

    // Act
    const response = await transport.send('http://127.0.0.1:1/v1/thing', {
      headers: { authorization: 'Bearer other' },
    });

    // Assert
    should(response.status).equal(401);
    should(rereads).equal(0);
  });

  it('should report the 401 when the health re-read fails', async () => {
    // Arrange
    let sends = 0;
    const transport = new SessionBearerTransport(
      {
        send: async () => {
          sends += 1;
          return sends === 1 ? new Response('{}', { status: 401 }) : ok;
        },
      },
      BEARER,
      {
        reread: async () => {
          throw new Error('daemon away');
        },
        adminToken: async () => ADMIN,
      },
    );

    // Act
    const response = await transport.send('http://127.0.0.1:1/v1/thing', {
      headers: { authorization: `Bearer ${BEARER}` },
    });

    // Assert
    should(response.status).equal(401);
    should(sends).equal(1);
  });
});
