import { afterAll, describe, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import { FileAuditJournal } from '../../../src/adapters/audit/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { NodePairingCryptography, StatePairingRepository } from '../../../src/adapters/pairing/index.ts';
import { AuditedPairingService, AuditLog } from '../../../src/lib/audit/index.ts';
import { createFoundationPaths, PairingDeviceRegistry, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

/**
 * What a REAL redemption leaves in the security log, read back off the disk.
 *
 * The unit tests prove the records the audited service writes; this proves the bytes — through the
 * production cryptography, device repository and file journal — for a right and a wrong code over both
 * carriers. The needles are what a redemption handles beyond a name: the code it spends (a live
 * credential) and the device key it registers. The log holds names and ids only, so neither may be in
 * any audit file, whatever the outcome.
 */
describe('a real pairing, read back off the disk', () => {
  it('should record each redemption by name and id and never write the code or the device key', async () => {
    // Arrange
    const home = await tempDirectory('fy-audit-pairing');
    const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
    const files = new StateFileSystem(paths);
    await files.ensureDirectory(paths.state, 0o700);
    const cryptography = new NodePairingCryptography();
    const repository = new StatePairingRepository(paths, files, cryptography);
    const state = await repository.open('workstation');
    const failures: string[] = [];
    const log = new AuditLog({
      journal: new FileAuditJournal(paths.state),
      clock: { now: () => new Date().toISOString() },
      failures: { auditWriteFailed: message => failures.push(message) },
    });
    const service = new AuditedPairingService(
      {
        daemonId: state.daemonId,
        daemonName: state.daemonName,
        advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
        carriers: [{ kind: 'direct', url: 'https://workstation.example.test' }],
        clock: { now: () => Date.now() },
        cryptography,
        devices: repository,
        credentials: new PairingDeviceRegistry(state.daemonId, state.devices),
        operatorPassword: { isSet: async () => true },
        clientName: 'fy',
      },
      { log, alert: { newDevicePaired: async () => undefined }, failures: { auditWriteFailed: m => failures.push(m) } },
    );
    const needles: string[] = [];
    const keys: string[] = [];

    // Act: each carrier gets a wrong code, then the right one.
    for (const carrier of ['direct', 'relay'] as const) {
      const minted = await service.mint();
      if (minted.kind !== 'minted') throw new Error('the fixture could not mint');
      const code = minted.response.code;
      needles.push(code);
      const wrong = `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`;
      const name = carrier === 'direct' ? 'Pixel 8' : 'Tablet';
      const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
      const deviceKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
      keys.push(deviceKey);
      const attempt = (value: string) =>
        service.redeemInSession(
          { code: value, deviceName: name, deviceKey, prove: async () => true },
          carrier === 'direct' ? { kind: 'direct', rateLimitKey: 'peer' } : { kind: 'relay' },
        );
      should((await attempt(wrong)).kind).equal('refused');
      const paired = await attempt(code);
      if (paired.kind !== 'paired') throw new Error('the fixture could not pair');
    }
    await log.flush(Date.now() + 120_000);
    const written = (
      await Promise.all(
        (await readdir(paths.state, { recursive: true }))
          .filter(file => file.startsWith('audit'))
          .map(async file => await readFile(join(paths.state, file), 'utf8')),
      )
    ).join('');
    const reading = await log.recent(50);
    const audited = (await readdir(paths.state)).filter(file => file.startsWith('audit'));

    // Assert
    should(failures).deepEqual([]);
    // Both stores were written: the pairings to the kept one, the refusals to the general one.
    should(audited.sort()).deepEqual(['audit-kept.jsonl', 'audit.jsonl']);
    should(keys).have.length(2);
    for (const needle of [...needles, ...keys]) should({ needle, leaked: written.includes(needle) }).deepEqual({
      needle,
      leaked: false,
    });
    const paired = reading.records.filter(record => record.event === 'device.paired');
    should(paired.map(record => [record.actor.deviceName, record.detail?.carrier])).deepEqual([
      ['Tablet', 'relay'],
      ['Pixel 8', 'direct'],
    ]);
    const devices = await repository.list();
    should(new Set(paired.map(record => record.subject))).deepEqual(new Set(devices.map(device => device.id)));
    should(
      reading.records.filter(record => record.event === 'pairing.refused').map(record => record.detail?.carrier),
    ).containDeep(['direct', 'relay']);
  });
});
