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
import {
  SecretExportResponseSchema,
  SecretImportOfferSchema,
  SecretImportResultSchema,
  SecretListSchema,
} from '@ferretry/protocol';
import should from 'should';
import { bootDaemon, stopBootedDaemons } from '../support/booted-daemon.ts';
import { cleanupTempDirectories } from '../support/repository.ts';

const VALUE = 'sk-live-clone-journey-0123';
const OTHER_VALUE = 'correct-horse-battery-staple';

afterEach(async () => {
  await stopBootedDaemons();
  await cleanupTempDirectories();
});

describe('copying secrets between two booted daemons', () => {
  it('should carry only ciphertext between them and file the copy once on the target', async () => {
    // Arrange
    const [source, target] = await Promise.all([bootDaemon('source'), bootDaemon('target')]);
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
    const [source, target] = await Promise.all([bootDaemon('source'), bootDaemon('target')]);
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
