/**
 * A loosening edit to a configuration file, made on disk, through the real composition root.
 *
 * WHAT ONLY THIS TIER CAN PROVE. The service, the routes and the Warden's file store each have their
 * own tests; none of them shows that `bin/fyd.ts` hands the Warden THE SAME evaluation the config
 * routes report on, so that an edit nobody confirmed is not quietly read by the Warden as in effect.
 * `bin/**` is in neither coverage ledger, so this is the only place that wiring executes.
 *
 * IT SPENDS NOTHING. Turning the Warden on is the loosening under test, but the daemon is stopped
 * before the Warden's first interval, and nothing here launches a harness.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigConfirmResultSchema, ConfigStatusViewSchema, WardenConfigViewSchema } from '@ferretry/protocol';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import { NO_RELAY_DIRECTORY, type RelayAdvertisement } from '../../../src/lib/index.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { OS_CHOSEN_PORT, recordedPort } from '../support/os-port.ts';

afterEach(async () => {
  await cleanupTempDirectories();
});

/** The production composition with the hosted relay directory held offline. */
function world(): DaemonWorld {
  return {
    ...buildWorld({}, { userHome: ABSENT_USER_HOME }),
    relayDirectory: { read: async (): Promise<RelayAdvertisement> => NO_RELAY_DIRECTORY },
  };
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) return;
    await Bun.sleep(50);
  }
  throw new Error('the daemon never answered its health probe');
}

describe('a loosening edit to warden.yaml on a booted daemon', () => {
  it('should hold it until the owner confirms it from this machine, then put it into effect', async () => {
    // Arrange
    const home = await tempDirectory('ferretry-config-journey-');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    process.env.FY_HOME = home;
    const opened = await world().storage.open();
    await opened.storage.close();
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: OS_CHOSEN_PORT }), {
      mode: 0o600,
    });
    const shutdown = new Promise<void>(resolve => {
      release = resolve;
    });
    const exit = start({ ...world(), untilShutdown: () => shutdown }, cleanups);
    const port = await recordedPort(home);
    await waitForHealth(port);
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const base = `http://127.0.0.1:${port}`;
    const wardenConfig = async (): Promise<{ readonly layers: { readonly llm: boolean } }> =>
      WardenConfigViewSchema.parse(await (await fetch(`${base}/v1/warden/config`, { headers })).json()).config;

    // Act
    // 1. The edit a person makes in their editor: the Warden turned on, which spends.
    await writeFile(
      join(home, 'config', 'warden.yaml'),
      '# every flag investigated, set by hand before the layers existed\ntriage: llm\n',
      {
        mode: 0o600,
      },
    );
    const heldWarden = await wardenConfig();
    const held = ConfigStatusViewSchema.parse(await (await fetch(`${base}/v1/config/status`, { headers })).json());
    const pending = held.pending.find(item => item.path === 'warden.yaml');
    // 2. A confirmation naming an etag nobody reviewed puts nothing into effect.
    const stale = ConfigConfirmResultSchema.parse(
      await (
        await fetch(`${base}/v1/config/confirm`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: 'warden.yaml', etag: 'not-the-reviewed-etag' }),
        })
      ).json(),
    );
    const staleWarden = await wardenConfig();
    // 3. The owner's confirmation, from this machine, of exactly the held edit.
    const confirmedResponse = await fetch(`${base}/v1/config/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'warden.yaml', etag: pending?.etag }),
    });
    const confirmed = ConfigConfirmResultSchema.parse(await confirmedResponse.json());
    const confirmedWarden = await wardenConfig();
    const after = ConfigStatusViewSchema.parse(await (await fetch(`${base}/v1/config/status`, { headers })).json());

    release();
    await exit;
    for (const cleanup of cleanups) await cleanup();

    // Assert
    // Held: the Warden still reads the tighter version, and the status says what waits and why.
    should(heldWarden.layers.llm).be.false();
    should(pending).not.be.undefined();
    should(pending?.changes.length).be.above(0);
    should(held.files.find(file => file.path === 'warden.yaml')?.state).equal('pending');
    should(stale).eql({ path: 'warden.yaml', confirmed: false });
    should(staleWarden.layers.llm).be.false();
    // Confirmed: in effect, and nothing waits any more.
    should(confirmedResponse.status).equal(200);
    should(confirmed).eql({ path: 'warden.yaml', confirmed: true });
    should(confirmedWarden.layers.llm).be.true();
    should(after.pending).eql([]);
    should(after.files.find(file => file.path === 'warden.yaml')?.state).equal('ok');
  });
});
