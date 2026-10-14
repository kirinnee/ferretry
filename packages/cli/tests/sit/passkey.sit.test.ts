/**
 * `fy passkey window` through the real composition root.
 *
 * `bin/**` is excluded from both coverage ledgers, so the unit tests prove the verb against a fake gateway
 * and NOT that the composition root hands it a client that dials the real routes with the host's
 * credential. This drives the shipped wiring against a small daemon double that answers exactly the two
 * routes the verb dials, parses the request through the shared schema the real daemon uses, and refuses
 * with the real daemon's codes.
 *
 * A DOUBLE, NOT `fyd`: like every journey in this tier it does not boot the daemon, so the 403 below
 * proves what the CLI says when it is told "not at the machine" — not that the real daemon tells a
 * non-owner so. That half is `packages/daemon/tests/unit/step-up/service.test.ts` and the mount's tests.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import {
  FULL_DEVICE_GRANTS,
  LIMITED_DEVICE_GRANTS,
  PASSKEY_WINDOW_PATH,
  type PairedDeviceId,
  PasskeyWindowRequestSchema,
  stepUpRefusalCode,
} from '@ferretry/protocol';
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

/** The paired-device list and the window route, answering the way the daemon does. */
class FakePasskeyDaemon {
  readonly opened: string[] = [];
  /** Who dialled the window route, by the bearer they sent: the owner holds the admin token. */
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

  async #handle(request: Request): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
    if (route === 'GET /v1/pair/devices') {
      return Response.json({
        devices: [device(PIXEL_ID, 'Pixel 8'), device(CHROME_ONE, 'Chrome'), device(CHROME_TWO, 'Chrome')],
        hostLocal: bearer === ADMIN_TOKEN,
        mayWiden: FULL_DEVICE_GRANTS,
      });
    }
    if (route === `POST ${PASSKEY_WINDOW_PATH}`) {
      this.bearers.push(bearer);
      const { deviceId } = PasskeyWindowRequestSchema.parse(await request.json());
      if (bearer !== ADMIN_TOKEN) {
        return Response.json(
          {
            error: 'only the owner at the machine can re-open a passkey window',
            code: stepUpRefusalCode('not-at-machine'),
          },
          { status: 403 },
        );
      }
      this.opened.push(deviceId);
      return Response.json({ deviceId, deviceName: 'Pixel 8', closesAt: new Date(Date.now() + 600_000).toISOString() });
    }
    return Response.json({ error: `unknown route ${route}` }, { status: 404 });
  }
}

let driver: CliDriver;
let daemon: FakePasskeyDaemon;

const cli = (args: string[], token = ADMIN_TOKEN): Promise<CliResult> =>
  driver.run(args, { FY_URL: daemon.baseUrl, FY_TOKEN: token, FY_SESSION_ID: '' });

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakePasskeyDaemon();
});

afterAll(() => {
  daemon.stop();
});

describe(`passkey window (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should open the window for a device named by its unique name, with the host credential', async () => {
    // Act
    const actual = await cli(['passkey', 'window', 'Pixel 8']);

    // Assert
    should(actual.code).equal(0, actual.err);
    should(actual.out).match(/The passkey window for Pixel 8 is open until \d\d:\d\d\./u);
    should(actual.out).containEql('Settings → Daemons → Security → Add a passkey within 10 minutes');
    should(daemon.opened.at(-1)).equal(PIXEL_ID);
    should(daemon.bearers.at(-1)).equal(ADMIN_TOKEN);
  });

  it('should open the window for a device named by id', async () => {
    // Act
    const actual = await cli(['passkey', 'window', CHROME_TWO]);

    // Assert
    should(actual.code).equal(0, actual.err);
    should(daemon.opened.at(-1)).equal(CHROME_TWO);
  });

  it('should refuse an ambiguous name with the ids to choose from, and open nothing', async () => {
    // Arrange
    const before = daemon.opened.length;

    // Act
    const actual = await cli(['passkey', 'window', 'Chrome']);

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql(CHROME_ONE).and.containEql(CHROME_TWO);
    should(daemon.opened).have.length(before);
  });

  it('should list the paired devices for an unknown name', async () => {
    // Act
    const actual = await cli(['passkey', 'window', 'Tablet']);

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('"Tablet"').and.containEql('"Pixel 8"');
  });

  it('should say only the owner at the machine may do this when a non-owner credential is refused', async () => {
    // Arrange
    const before = daemon.opened.length;

    // Act
    const actual = await cli(['passkey', 'window', 'Pixel 8'], 'not-the-admin-token');

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('Only the owner at the machine');
    should(actual.out).equal('');
    should(daemon.opened).have.length(before);
  });

  it('should say how to start the daemon when nothing answers', async () => {
    // Act — a port nothing listens on: bind one, learn its number, release it.
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const dead = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    const actual = await driver.run(['passkey', 'window', 'Pixel 8'], {
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
    const actual = await driver.run(['passkey', '--help'], { FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' });

    // Assert
    should(actual.code).equal(0);
    should(actual.out).containEql('window <device>').and.containEql('never "at the machine"');
  });
});
