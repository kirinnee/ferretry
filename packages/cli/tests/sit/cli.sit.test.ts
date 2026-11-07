import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { standInDaemon, HEALTH } from '../integration/support/stand-in-daemon.ts';
import { type CliDriver, defaultCommand, ProcessCliDriver } from './driver.ts';

// SIT journeys against the entry as a separate process. The binary name is read from package.json, never written here.
const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const binEntry = Object.values(pkg.bin)[0] ?? 'bin/fy.ts';
const driver: CliDriver = new ProcessCliDriver(defaultCommand(binEntry, join(dirname(import.meta.path), '..', '..')));

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-sit-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const PLUGINS = { protocol: 1, plugins: [{ id: 'tiny', on: true, contract: 'x' }] };
/** What the daemon's own host checks say when everything is where it should be (`GET /v1/doctor`). */
const READY_REPORT = { checks: [], harnesses: [], ready: true, limitation: 'presence on PATH only' };
const daemon = () =>
  standInDaemon((_request, path) =>
    path === '/v1/health'
      ? Response.json(HEALTH)
      : path === '/v1/plugins'
        ? Response.json(PLUGINS)
        : path === '/v1/doctor'
          ? Response.json(READY_REPORT)
          : Response.json({ error: 'no' }, { status: 404 }),
  );
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: home,
  FY_HOME: join(home, 'fy-home'),
  ...extra,
});

describe(`${binaryName} (SIT)`, () => {
  it('prints a semver with --version', async () => {
    const actual = await driver.run(['--version'], env());
    should(actual.code).equal(0);
    should(actual.out.trim()).match(/^\d+\.\d+\.\d+/);
  });

  it('shows a usage banner naming the binary, and the shell’s own verbs, with --help', async () => {
    const actual = await driver.run(['--help'], env());
    should(actual.code).equal(0);
    should(actual.out).containEql(`Usage: ${binaryName} <verb>`);
    for (const verb of ['plugin list', 'words', 'doctor', 'daemon status', 'ask']) should(actual.out).containEql(verb);
  });

  it('rejects an unknown verb with exit 2 and a hint', async () => {
    const actual = await driver.run(['nonsense'], env());
    should(actual.code).equal(2);
    should(actual.err).containEql('unknown verb "nonsense"');
  });

  it('reports a running daemon with `daemon status`, and exits 1 for a stopped one', async () => {
    const { url } = daemon();
    const up = await driver.run(['daemon', 'status'], env({ FY_URL: url, FY_TOKEN: 'owner-token' }));
    should(up.code).equal(0);
    should(up.out).containEql('version  5.0.0');
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const gone = `http://127.0.0.1:${String(dead.port)}`;
    await dead.stop(true);
    const down = await driver.run(['daemon', 'status'], env({ FY_URL: gone }));
    should(down.code).equal(1);
    should(down.err).containEql('not running');
  });

  it('lists the daemon’s plugins with `plugin list`, presenting FY_TOKEN', async () => {
    const { url, seen } = daemon();
    const actual = await driver.run(['plugin', 'list'], env({ FY_URL: url, FY_TOKEN: 'owner-token' }));
    should(actual.code).equal(0);
    should(actual.out).match(/tiny\s+data\s+on/u);
    should(seen.find(request => request.path === '/v1/plugins')?.headers).have.property(
      'authorization',
      'Bearer owner-token',
    );
  });

  it('S53 presents a ferret’s own fys_ bearer, and says nothing of the admin token, when run in a pane', async () => {
    const { url, seen } = daemon();
    const actual = await driver.run(
      ['plugin', 'list'],
      env({ FY_URL: url, FY_SESSION_TOKEN: 'fys_pane-credential', FY_SESSION_ID: 'pane-1' }),
    );
    should(actual.code).equal(0);
    const request = seen.find(candidate => candidate.path === '/v1/plugins');
    should(request?.headers).have.property('authorization', 'Bearer fys_pane-credential');
    should(request?.headers).have.property('x-ferretry-session-id', 'pane-1');
  });

  it('S57 refuses a ferret credential for a daemon that is not on this machine, without sending it', async () => {
    const actual = await driver.run(
      ['plugin', 'list'],
      env({ FY_URL: 'https://daemon.example:7431', FY_SESSION_TOKEN: 'fys_pane-credential' }),
    );
    should(actual.code).equal(1);
    should(actual.err).containEql('FY_TOKEN is required when the daemon is not on this machine');
  });

  it('runs `doctor` against a daemon and exits 0 when everything agrees', async () => {
    const { url } = daemon();
    const actual = await driver.run(['doctor'], env({ FY_URL: url, FY_TOKEN: 'owner-token' }));
    should(actual.code).equal(0);
    should(actual.out).containEql('ok    daemon: answering');
  });

  it('S60 warns in a pane when FY_TOKEN is set', async () => {
    const { url } = daemon();
    const actual = await driver.run(['doctor'], env({ FY_URL: url, FY_TOKEN: 'owner-token', FY_SESSION_ID: 'pane-1' }));
    should(actual.out).containEql('FY_TOKEN is set in this ferret’s environment');
  });

  it('prints the glossary note when the daemon is away, and exits 0 for an empty glossary', async () => {
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const gone = `http://127.0.0.1:${String(dead.port)}`;
    await dead.stop(true);
    const actual = await driver.run(['words'], env({ FY_URL: gone }));
    should(actual.code).equal(0);
    should(actual.err).containEql('compiled into this fy');
  });
});
