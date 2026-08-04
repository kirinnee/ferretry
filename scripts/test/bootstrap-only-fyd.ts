#!/usr/bin/env bun
/**
 * A stand-in `fyd` that performs the REAL state-home bootstrap and nothing else.
 *
 * The first-run deadlock this exists to catch lives in the seam between two packages: the CLI creates
 * `<state home>/logs` before it launches the daemon, and the daemon's layout model decides whether
 * that home may be initialized. A unit test over either side alone passes on a broken build, so the
 * regression test drives the shipped `fy daemon start` against this executable, which runs the
 * daemon's own `DaemonStorageFactory` exactly as `packages/daemon/bin/fyd.ts` does.
 *
 * What it deliberately does NOT do is boot the real daemon. The daemon's API address comes from
 * `config/daemon.json`, whose default is a fixed `127.0.0.1:7337` with no environment override — and
 * that file cannot be seeded ahead of time, because a config document in an unmarked home is exactly
 * the foreign state bootstrap must refuse. A real `fyd` in a test would therefore have to bind a known
 * port and could answer the CLI's health probe from the host's live daemon. This serves health on the
 * ephemeral port the E2E fixture leased instead, so the journey is hermetic.
 *
 * Point `FY_DAEMON_BIN` at this file where it sits — it imports the daemon by relative path, so a copy
 * elsewhere would not resolve — and leave a `fyd.port` file in the fixture's `bin/` directory.
 */
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../packages/daemon/src/adapters/index.ts';
import daemonPackage from '../../packages/daemon/package.json' with { type: 'json' };

/** Derived from the package's `.bin` key, the same single source the real daemon reads it from. */
const DAEMON_NAME = Object.keys(daemonPackage.bin ?? {})[0] ?? daemonPackage.name;

function fail(message: string): never {
  // The real daemon reports a startup failure on stderr, which its supervisor has already redirected
  // into the log file. Mirroring that is the whole point: on a broken build this is the line the user
  // finds in `~/.ferretry/logs/fyd.log`.
  process.stderr.write(`${DAEMON_NAME}: ${message}\n`);
  process.exit(1);
}

/**
 * The port comes from a `fyd.port` file in the first `PATH` entry, never from the environment.
 *
 * `fy daemon start` hands its child exactly two variables — `FY_HOME` and `PATH` — because a daemon
 * must not inherit the shell that happened to launch it. That contract is part of what is under test,
 * so it is not loosened for a test's convenience. The state home is not an option either: a file of
 * ours sitting there before bootstrap is precisely the foreign state these journeys are about. The
 * E2E fixture always puts its own `bin/` directory first on `PATH`, so that is where it leaves this
 * run's leased port.
 */
const binDirectory = (process.env.PATH ?? '').split(delimiter)[0] ?? '';
if (binDirectory === '') fail('PATH must name the E2E bin directory first');
const portFile = join(binDirectory, 'fyd.port');
let portText: string;
try {
  portText = readFileSync(portFile, 'utf8').trim();
} catch {
  fail(`no port sidecar at ${portFile}`);
}
if (!/^[0-9]+$/.test(portText)) fail(`${portFile} must hold an integer port`);
const port = Number.parseInt(portText, 10);
if (port < 1024 || port > 65_535) fail(`${portFile} must hold an unprivileged port from 1024 through 65535`);

const factory = new DaemonStorageFactory(
  new RuntimeEnvironment(),
  new StateFileSystemFactory(),
  new StateHomeLayout(),
  new SqliteHomeLockFactory(),
  new BunSqliteIndexFactory(),
  new SystemClock(),
  () => new KeyedSerialExecutor(),
);

const opened = await factory.open().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

process.stdout.write(`${DAEMON_NAME}: state home ready (created ${String(opened.layout.created)})\n`);

const health = {
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete',
  bootstrapDegraded: false,
  version: '0.0.0',
  pid: process.pid,
  sessions: 0,
  running: 0,
  monitors: 0,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: 0,
  wardenTimerArmed: true,
  eventLoopLagMs: 0,
  lastSelfCheckAt: '2026-01-01T00:00:00.000Z',
  wedgeCount: 0,
  scratchGcEnabled: false,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: '2026-01-01T00:00:00.000Z',
};

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: request => {
      const url = new URL(request.url);
      const headers = { 'x-fy-version': request.headers.get('x-fy-version') ?? '0.0.0' };
      if (url.pathname !== '/v1/health') {
        return Response.json({ error: 'no such route', code: 'unknown_route', path: url.pathname }, { status: 404 });
      }
      return Response.json(health, { headers });
    },
  });
} catch {
  await opened.storage.close();
  fail('could not bind the loopback server');
}

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  // The lifetime lock is released the way the real daemon releases it, so a later start in the same
  // journey meets a cleanly closed home rather than one that still looks occupied.
  void server
    .stop(true)
    .then(async () => await opened.storage.close())
    .catch(() => undefined)
    .finally(() => process.exit(0));
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
