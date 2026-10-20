/**
 * Copying secrets from one REAL daemon to another, through both composition roots.
 *
 * WHAT ONLY THIS TIER CAN PROVE. The services, the routes and the crypto each have unit tests; none of
 * them shows that `bin/fyd.ts` signs an offer with THE identity its daemon id fingerprints, seals with
 * the vault it really holds, and files the copy into the store its own `GET /v1/secrets` lists. Two
 * daemons run as two processes, each with its own state home, its own identity and its own vault, and
 * the test plays the browser: it carries the offer to the source and the bundle back to the target,
 * and never holds a value.
 *
 * Both daemons are driven with their own host admin token, so neither asks for a passkey (the owner at
 * the machine is ungoverned, docs/grants.md). The passkey a governed device must prove for the export is
 * the route's, and `tests/unit/runtime/mounts/secret-clone.test.ts` pins it.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  SecretExportResponseSchema,
  SecretImportOfferSchema,
  SecretImportResultSchema,
  SecretListSchema,
} from '@ferretry/protocol';
import should from 'should';
import { buildWorld } from '../../../bin/fyd.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const FYD_ENTRY = resolve(import.meta.dir, '../../../bin/fyd.ts');
const VALUE = 'sk-live-clone-journey-0123';
const OTHER_VALUE = 'correct-horse-battery-staple';

const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  await cleanupTempDirectories();
});

async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('the fixture server reported no port');
  return port;
}

interface Daemon {
  readonly base: string;
  readonly headers: Readonly<Record<string, string>>;
  post(path: string, body?: unknown): Promise<Response>;
}

/** One daemon in its own process and state home, with the hosted relay switched off. */
async function boot(label: string): Promise<Daemon> {
  const home = await tempDirectory(`ferretry-clone-${label}-`);
  const port = await freeLoopbackPort();
  const previous = process.env.FY_HOME;
  process.env.FY_HOME = home;
  const opened = await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open();
  await opened.storage.close();
  if (previous === undefined) delete process.env.FY_HOME;
  else process.env.FY_HOME = previous;
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(
    join(home, 'config', 'daemon.json'),
    JSON.stringify({ host: '127.0.0.1', port, relay: { url: 'ws://127.0.0.1:9', enabled: false } }),
    { mode: 0o600 },
  );
  const child = Bun.spawn({
    cmd: [process.execPath, FYD_ENTRY],
    env: { ...process.env, FY_HOME: home, HOME: ABSENT_USER_HOME },
    stdin: 'ignore',
    stdout: Bun.file(join(home, 'fyd.out')),
    stderr: Bun.file(join(home, 'fyd.err')),
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 400 && !healthy; attempt += 1) {
    healthy = (await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true;
    if (!healthy) await Bun.sleep(50);
  }
  if (!healthy) throw new Error(`the ${label} daemon never answered: ${await readFile(join(home, 'fyd.err'), 'utf8')}`);
  const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    base,
    headers,
    post: async (path, body) =>
      await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

describe('copying secrets between two booted daemons', () => {
  it('should carry only ciphertext between them and file the copy once on the target', async () => {
    // Arrange
    const [source, target] = await Promise.all([boot('source'), boot('target')]);
    for (const [name, value] of [
      ['API_KEY', VALUE],
      ['DB_PASSWORD', OTHER_VALUE],
    ])
      should((await source.post('/v1/secrets', { name, value })).status).equal(200);

    // Act — the browser's three steps.
    const offerResponse = await target.post('/v1/secrets/imports');
    const offerText = await offerResponse.text();
    const offer = SecretImportOfferSchema.parse(JSON.parse(offerText));
    const exportResponse = await source.post(`/v1/secrets/exports/${offer.importId}`, {
      offer,
      names: ['API_KEY'],
    });
    const exportText = await exportResponse.text();
    const { bundle } = SecretExportResponseSchema.parse(JSON.parse(exportText));
    const importResponse = await target.post(`/v1/secrets/imports/${offer.importId}`, { bundle });
    const imported = SecretImportResultSchema.parse(await importResponse.json());
    const replay = await target.post(`/v1/secrets/imports/${offer.importId}`, { bundle });
    const listed = SecretListSchema.parse(
      await (await fetch(`${target.base}/v1/secrets`, { headers: target.headers })).json(),
    );
    const back = await target.post('/v1/secrets/imports');
    const backOffer = SecretImportOfferSchema.parse(await back.json());
    const toItself = await target.post(`/v1/secrets/exports/${backOffer.importId}`, {
      offer: backOffer,
      names: ['API_KEY'],
    });

    // Assert
    should(offerResponse.status).equal(201);
    should(exportResponse.status).equal(200);
    should(importResponse.status).equal(200);
    // Nothing the browser carried holds a value in clear.
    should(offerText).not.containEql(VALUE);
    should(exportText).not.containEql(VALUE);
    should(exportText).not.containEql(OTHER_VALUE);
    should(bundle.targetDaemonId).equal(offer.daemonId);
    should(bundle.sourceDaemonId).not.equal(offer.daemonId);
    should(imported.imported).deepEqual(['API_KEY']);
    should(imported.sourceDaemonId).equal(bundle.sourceDaemonId);
    should(replay.status).equal(409);
    should(listed.secrets.map(secret => secret.name)).deepEqual(['API_KEY']);
    should(((await toItself.json()) as { code: string }).code).equal('same_machine');
  }, 60_000);

  it('should let the target USE the copied value, proving it arrived intact', async () => {
    // Arrange
    const [source, target] = await Promise.all([boot('source'), boot('target')]);
    await source.post('/v1/secrets', { name: 'API_KEY', value: VALUE });
    const offer = SecretImportOfferSchema.parse(await (await target.post('/v1/secrets/imports')).json());
    const { bundle } = SecretExportResponseSchema.parse(
      await (await source.post(`/v1/secrets/exports/${offer.importId}`, { offer, names: ['API_KEY'] })).json(),
    );
    await target.post(`/v1/secrets/imports/${offer.importId}`, { bundle });

    // Act — the child compares the value it was given; only "same" or "different" comes back.
    const used = await target.post('/v1/secrets/use', {
      command: ['sh', '-c', `[ "$API_KEY" = '${VALUE}' ] && echo same || echo different`],
      secrets: ['API_KEY'],
      cwd: '/',
    });

    // Assert
    should(used.status).equal(200);
    should(((await used.json()) as { stdout: string }).stdout.trim()).equal('same');
  }, 60_000);
});
