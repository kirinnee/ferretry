/**
 * `fy device revoke` through the real composition root.
 *
 * Like every journey in this tier it drives the shipped wiring against a small daemon double, so what it
 * proves is what the CLI SENDS and SAYS: the DELETE goes to the one device's route carrying the host's
 * admin credential, and a daemon that answers 404 or nothing is worded as one sentence. That the REAL
 * daemon closes the sessions and writes the audit record is `packages/daemon/tests/unit/pairing/` and the
 * pairing mount's tests — a double cannot prove it.
 *
 * SIT TIER: it spawns `fy` (`CLI_BIN`, else the bun entry), so it needs the built CLI and the generated registry.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import type { PairedDeviceId } from '../../../../contract/index.ts';
import should from 'should';
import { bootstrapAnswer, type CliDriver, type CliResult, sitDriver, sitEnvironment } from './support.ts';

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
    const bootstrap = bootstrapAnswer(request);
    if (bootstrap !== undefined) return bootstrap;
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
  driver.run(args, sitEnvironment({ FY_URL: daemon.baseUrl, FY_TOKEN: ADMIN_TOKEN }));

beforeAll(() => {
  driver = sitDriver();
  daemon = new FakeRevokeDaemon();
});

afterAll(() => {
  daemon.stop();
});

describe(`device revoke (SIT, ${process.env.CLI_BIN ? 'compiled binary' : 'bun entry'})`, () => {
  it('P120 should refuse off a terminal without --yes, and revoke nothing', async () => {
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

  it('P117 should revoke a device by its unique name with the host credential, in one sentence', async () => {
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
        bootstrapAnswer(request) ??
        (request.method === 'GET'
          ? Response.json({ devices: [gone], hostLocal: true, mayWiden: FULL_DEVICE_GRANTS })
          : Response.json({ error: 'device not found', code: 'pairing_device_not_found' }, { status: 404 })),
    });

    // Act
    const actual = await driver.run(
      ['device', 'revoke', CHROME_ONE, '--yes'],
      sitEnvironment({ FY_URL: `http://127.0.0.1:${racing.port}`, FY_TOKEN: ADMIN_TOKEN }),
    );
    racing.stop(true);

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('no longer knows that device').and.containEql('device ls');
    should(daemon.revoked).have.length(original);
  });

  it('P121 should say how to start the daemon when nothing answers', async () => {
    // Act
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const dead = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    const actual = await driver.run(
      ['device', 'revoke', 'Pixel 8', '--yes'],
      sitEnvironment({ FY_URL: dead, FY_TOKEN: ADMIN_TOKEN }),
    );

    // Assert
    should(actual.code).equal(1);
    should(actual.err).containEql('daemon did not answer').and.containEql('daemon start');
  });

  it('should be mounted and name itself in --help', async () => {
    // Act
    const actual = await driver.run(['device', 'revoke', '--help'], sitEnvironment({ FY_TOKEN: '', FY_URL: '' }));

    // Assert — the 5.0 shell renders the manifest's summary; the long help (`deviceRevokeHelp`) has no seat yet.
    should(actual.code).equal(0);
    should(actual.out).containEql('device revoke').and.containEql("take one device's access away");
  });
});
