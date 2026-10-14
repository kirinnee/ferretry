/**
 * `fy device revoke` through the real composition root.
 *
 * Like every journey in this tier it drives the shipped wiring against a small daemon double, so what it
 * proves is what the CLI SENDS and SAYS: the DELETE goes to the one device's route carrying the host's
 * admin credential, and a daemon that answers 404 or nothing is worded as one sentence. That the REAL
 * daemon closes the sessions and writes the audit record is `packages/daemon/tests/unit/pairing/` and the
 * pairing mount's tests — a double cannot prove it.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { LIMITED_DEVICE_GRANTS, FULL_DEVICE_GRANTS, type PairedDeviceId } from '@ferretry/protocol';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const ADMIN_TOKEN = 'sit-admin-token';
const PIXEL_ID = `fy_device_id_${'a'.repeat(22)}` as PairedDeviceId;
const CHROME_ONE = `fy_device_id_${'b'.repeat(22)}` as PairedDeviceId;
const CHROME_TWO = `fy_device_id_${'c'.repeat(22)}` as PairedDeviceId;

const device = (id: PairedDeviceId, name: string) => ({
  id,
  name,
  platform: 'browser',
  createdAt: '2026-10-01T09:00:00.000Z',
  lastSeenAt: '2026-10-12T09:00:00.000Z',
  idleExpiresAt: '2026-11-11T09:00:00.000Z',
  grants: LIMITED_DEVICE_GRANTS,
});

/** The paired-device list and the revoke route, answering the way the daemon does. */
class FakeRevokeDaemon {
  paired = [device(PIXEL_ID, 'Pixel 8'), device(CHROME_ONE, 'Chrome'), device(CHROME_TWO, 'Chrome')];
  readonly revoked: string[] = [];
  readonly bearers: string[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.#server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => this.#handle(request) });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  stop(): void {
    this.#server.stop(true);
  }

  #view(): Response {
    return Response.json({ devices: this.paired, hostLocal: true, mayWiden: FULL_DEVICE_GRANTS });
  }

  #handle(request: Request): Response {
    const path = new URL(request.url).pathname;
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
    if (request.method === 'GET' && path === '/v1/pair/devices') return this.#view();
    const target = /^\/v1\/pair\/devices\/(?<id>[^/]+)$/u.exec(path)?.groups?.id;
    if (request.method === 'DELETE' && target !== undefined) {
      this.bearers.push(bearer);
      if (!this.paired.some(entry => entry.id === target))
        return Response.json({ error: 'device not found', code: 'pairing_device_not_found' }, { status: 404 });
      this.revoked.push(target);
      this.paired = this.paired.filter(entry => entry.id !== target);
      return this.#view();
    }
    return Response.json({ error: `unknown route ${request.method} ${path}` }, { status: 404 });
  }
}

let driver: CliDriver;
let daemon: FakeRevokeDaemon;

const cli = (args: string[]): Promise<CliResult> =>
  driver.run(args, { FY_URL: daemon.baseUrl, FY_TOKEN: ADMIN_TOKEN, FY_SESSION_ID: '' });

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakeRevokeDaemon();
});

afterAll(() => {
  daemon.stop();
});

describe(`device revoke (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should refuse off a terminal without --yes, and revoke nothing', async () => {
    // Act
    const actual = await cli(['device', 'revoke', 'Pixel 8']);

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('--yes');
    should(actual.out).equal('');
    should(daemon.revoked).be.empty();
  });

  it('should refuse an ambiguous name with the ids to choose from, and revoke nothing', async () => {
    // Act
    const actual = await cli(['device', 'revoke', 'Chrome', '--yes']);

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql(CHROME_ONE).and.containEql(CHROME_TWO);
    should(daemon.revoked).be.empty();
  });

  it('should revoke a device by its unique name with the host credential, in one sentence', async () => {
    // Act
    const actual = await cli(['device', 'revoke', 'Pixel 8', '--yes']);

    // Assert
    should(actual.code).equal(0, actual.err);
    should(actual.out.trim()).equal(
      'Pixel 8 can no longer reach this machine; its open sessions were closed and its passkeys forgotten.',
    );
    should(daemon.revoked).eql([PIXEL_ID]);
    should(daemon.bearers).eql([ADMIN_TOKEN]);
  });

  it('should revoke a device named by id', async () => {
    // Act
    const actual = await cli(['device', 'revoke', CHROME_TWO, '-y']);

    // Assert
    should(actual.code).equal(0, actual.err);
    should(daemon.revoked.at(-1)).equal(CHROME_TWO);
  });

  it('should say the device is unknown once it is gone', async () => {
    // Act
    const actual = await cli(['device', 'revoke', 'Pixel 8', '--yes']);

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('"Pixel 8"').and.containEql('paired devices');
  });

  it('should say the device is already gone when the daemon answers 404 for it', async () => {
    // Arrange — the list still shows it, the revoke finds nothing: somebody else revoked it between the two.
    const gone = daemon.paired.find(entry => entry.id === CHROME_ONE);
    should(gone).not.be.undefined();
    const original = daemon.revoked.length;
    const racing = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request =>
        request.method === 'GET'
          ? Response.json({ devices: [gone], hostLocal: true, mayWiden: FULL_DEVICE_GRANTS })
          : Response.json({ error: 'device not found', code: 'pairing_device_not_found' }, { status: 404 }),
    });

    // Act
    const actual = await driver.run(['device', 'revoke', CHROME_ONE, '--yes'], {
      FY_URL: `http://127.0.0.1:${racing.port}`,
      FY_TOKEN: ADMIN_TOKEN,
      FY_SESSION_ID: '',
    });
    racing.stop(true);

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('no longer knows that device').and.containEql('device ls');
    should(daemon.revoked).have.length(original);
  });

  it('should say how to start the daemon when nothing answers', async () => {
    // Act
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const dead = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    const actual = await driver.run(['device', 'revoke', 'Pixel 8', '--yes'], {
      FY_URL: dead,
      FY_TOKEN: ADMIN_TOKEN,
      FY_SESSION_ID: '',
    });

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('daemon did not answer').and.containEql('daemon start');
  });

  it('should be mounted and explain itself in --help', async () => {
    // Act
    const actual = await driver.run(['device', 'revoke', '--help'], { FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' });

    // Assert
    should(actual.code).equal(0);
    should(actual.out).containEql('stolen phone').and.containEql('--yes');
  });
});
