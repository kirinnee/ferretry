import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';

/**
 * Journeys for the `fy daemon …` control group.
 *
 * Only the READ-ONLY verbs are driven end to end. `install`, `start`, `stop` and `restart` reach a
 * real service manager and a real process, so exercising them here would touch this host's live
 * installation; their decision logic is covered by the unit tier and their IO by the integration tier
 * against throwaway children in temp directories.
 *
 * What this proves is what those tiers cannot: the shipped binary actually constructs the daemon
 * controller, resolves its layout from the environment, reaches `/v1/health` over the protocol client,
 * and streams the log file it configured.
 */

const health = {
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete',
  bootstrapDegraded: false,
  version: '0.0.0',
  // The CLI checks this pid for liveness with signal 0, so it must be a real process we own.
  pid: process.pid,
  sessions: 2,
  running: 1,
  monitors: 1,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: 5,
  wardenTimerArmed: true,
  eventLoopLagMs: 0.75,
  lastSelfCheckAt: '2026-07-31T09:00:00.000Z',
  wedgeCount: 0,
  scratchGcEnabled: true,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: '2026-07-31T09:00:01.000Z',
};

interface Stub {
  readonly paths: string[];
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** A stub daemon on an OS-assigned ephemeral loopback port — never a real `fyd`, never a known port. */
function startStubDaemon(serving: boolean): Stub {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      const headers = { 'x-fy-version': request.headers.get('x-fy-version') ?? '0.0.0' };
      if (!serving || url.pathname !== '/v1/health') {
        return Response.json(
          { error: 'no such route', code: 'unknown_route', path: url.pathname },
          {
            status: 404,
            headers,
          },
        );
      }
      return Response.json(health, { headers });
    },
  });
  return {
    paths,
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * Records the stub's address where the CLI's daemon verbs look for this state home's daemon.
 *
 * `FY_URL` IS NOT ENOUGH ANY MORE, on purpose (#224): `status`, `stop`, `restart` and `reset` manage
 * the daemon process on THIS host, so they probe the address the state home recorded in
 * `config/daemon.json` and never a forwarded `FY_URL` — honouring it reported a stranger's counts
 * and handed its pid to a local SIGTERM. Without this file they probe the fixed default port, which
 * is the host's live daemon when there is one. `FY_URL` stays in `connection` for the verbs that do
 * honour it.
 */
async function recordAddress(environment: E2eEnvironment, stub: Stub): Promise<void> {
  const config = join(environment.paths.fyHome, 'config');
  await mkdir(config, { recursive: true });
  const port = Number(new URL(stub.baseUrl).port);
  await writeFile(join(config, 'daemon.json'), `${JSON.stringify({ host: '127.0.0.1', port })}\n`, 'utf8');
}

function connection(stub: Stub, daemonBinary: string): Record<string, string> {
  return { FY_URL: stub.baseUrl, FY_TOKEN: 'e2e-token', FY_DAEMON_BIN: daemonBinary };
}

/** An absolute path inside the temp tree. `status` and `logs` never execute it. */
function fakeDaemonBinary(binDirectory: string): string {
  return join(binDirectory, 'fyd');
}

describe('daemon control journeys', () => {
  it('should report a serving daemon as a human summary', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = startStubDaemon(true);
      await recordAddress(environment, stub);

      try {
        // Act
        const actual = await environment.runFy(
          ['daemon', 'status'],
          connection(stub, fakeDaemonBinary(environment.paths.bin)),
        );

        // Assert
        should(actual.code).equal(0);
        should(actual.out).containEql('fyd is serving');
        should(actual.out).containEql(`pid ${String(process.pid)}`);
        should(actual.out).containEql('sessions 2 (1 running, 0 unmonitored)');
        should(stub.paths).containEql('/v1/health');
      } finally {
        await stub.stop();
      }
    });
  });

  it('should emit a machine-readable status behind --json', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = startStubDaemon(true);
      await recordAddress(environment, stub);

      try {
        // Act
        const actual = await environment.runFy(
          ['daemon', 'status', '--json'],
          connection(stub, fakeDaemonBinary(environment.paths.bin)),
        );

        // Assert — kteam only ever printed raw health JSON; the shape here is the stated contract.
        should(actual.code).equal(0);
        const payload = JSON.parse(actual.out) as {
          daemon: string;
          reachability: string;
          health: { pid: number };
        };
        should(payload.daemon).equal('fyd');
        should(payload.reachability).equal('serving');
        should(payload.health.pid).equal(process.pid);
      } finally {
        await stub.stop();
      }
    });
  });

  it('should fail when the daemon does not answer, so a script can branch on it', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — the stub is up but answers nothing, standing in for a host with no daemon.
      const stub = startStubDaemon(false);
      await recordAddress(environment, stub);

      try {
        // Act
        const actual = await environment.runFy(
          ['daemon', 'status'],
          connection(stub, fakeDaemonBinary(environment.paths.bin)),
        );

        // Assert
        should(actual.code).equal(1);
        should(actual.out).containEql('fyd is stopped');
        should(actual.out).containEql('not managed by a service manager');
      } finally {
        await stub.stop();
      }
    });
  });

  it('should say the log does not exist yet rather than print nothing', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = startStubDaemon(false);
      await recordAddress(environment, stub);

      try {
        // Act
        const actual = await environment.runFy(
          ['daemon', 'logs'],
          connection(stub, fakeDaemonBinary(environment.paths.bin)),
        );

        // Assert — kteam swallowed the read error and printed an empty string.
        should(actual.code).equal(0);
        should(actual.out).containEql('no fyd log at');
        should(actual.out).containEql(join(environment.paths.fyHome, 'logs', 'fyd.log'));
      } finally {
        await stub.stop();
      }
    });
  });

  it('should stream the log it configured the service manager to write', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = startStubDaemon(false);
      await recordAddress(environment, stub);
      const logDirectory = join(environment.paths.fyHome, 'logs');
      await mkdir(logDirectory, { recursive: true });
      await writeFile(join(logDirectory, 'fyd.log'), 'bound on 127.0.0.1\nready\n', 'utf8');

      try {
        // Act
        const actual = await environment.runFy(
          ['daemon', 'logs'],
          connection(stub, fakeDaemonBinary(environment.paths.bin)),
        );

        // Assert
        should(actual.code).equal(0);
        should(actual.out).containEql('bound on 127.0.0.1');
        should(actual.out).containEql('ready');
      } finally {
        await stub.stop();
      }
    });
  });

  /**
   * PRODUCT BUG (minor, reported to the e2e lead) behind this test's ~31s timeouts: `start` takes
   * the lifecycle claims BEFORE it looks for the executable (`DaemonController.start` serializes,
   * then `#start` calls `installedDaemon()`). On Linux one of those claims is HOST-GLOBAL
   * (`/tmp/.<uid>.systemd.fyd.service.target.lifecycle.lock`, `layout.ts` `lifecycleLocksFor`), so
   * while any other `fy daemon` verb on the machine holds it — a concurrent e2e run, or a claim
   * stranded by a killed `start` — this refusal waits up to 140s instead of saying at once that there
   * is no `fyd`, and the fixture's 30s command timeout fires first. Run this file with no other
   * `fy daemon` lifecycle verb active on the host.
   */
  it('should require a live executable only for the verbs that launch one', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const stub = startStubDaemon(false);
      await recordAddress(environment, stub);

      try {
        // Act — no `FY_DAEMON_BIN`, and the temp PATH has no `fyd`.
        const variables = {
          FY_URL: stub.baseUrl,
          FY_TOKEN: 'e2e-token',
        };
        const status = await environment.runFy(['daemon', 'status'], variables);
        const which = await environment.runFy(['daemon', 'which'], variables);
        const start = await environment.runFy(['daemon', 'start'], variables);

        // Assert — reporting still works on a host with no daemon installed, and says why there is
        // none rather than a bare absence. Only the verbs that must name a file to launch refuse.
        should(status.code).equal(1);
        should(status.out).containEql('fyd is stopped');
        should(status.err).not.containEql('cannot find fyd on PATH');
        should(which.code).equal(0);
        should(which.out).containEql('installed: cannot find fyd on PATH');
        should(which.out).containEql('running: daemon is not running');
        should(start.code).equal(1);
        should(start.err).containEql('cannot find fyd on PATH');
      } finally {
        await stub.stop();
      }
    });
  });

  it('should keep --help working on a host with no daemon, token, or executable', async () => {
    await withE2eEnvironment(async environment => {
      // Act
      const actual = await environment.runFy(['daemon', '--help']);

      // Assert — the controller is built per verb, so nothing resolves the layout here.
      should(actual.code).equal(0);
      should(actual.out).containEql('install');
      should(actual.out).containEql('status');
      should(actual.out).containEql('logs');
    });
  });
});
