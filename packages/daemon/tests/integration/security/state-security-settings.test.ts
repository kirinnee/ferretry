import { afterAll, describe, it } from 'bun:test';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { DEFAULT_SECURITY_SETTINGS, type SecuritySettings } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { SecuritySettingsDamaged, StateSecuritySettingsDocument } from '../../../src/adapters/security/index.ts';
import { createFoundationPaths, type FileSystemPort, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The security settings document on a real state home (`docs/design/zero-trust.md` B6).
 *
 * A document that does not parse is DAMAGE, never "absent": the service reads damage as its strictest
 * reading, so this adapter's job is to say "unreadable" loudly and name the file while it does.
 */
afterAll(async () => {
  await cleanupTempDirectories();
});

const SETTINGS: SecuritySettings = {
  stepUpWindowMinutes: 5,
  deviceKeyRotationDays: 14,
  unlockOnOpen: true,
  stepUpOnActions: false,
  unlockValidityHours: 2,
  idleExpiryDays: 9,
};
const UPDATED_AT = '2026-10-01T12:00:00.000Z';

async function fixture(label: string) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.state, 0o700);
  const document = new StateSecuritySettingsDocument(paths, files);
  return { paths, files, document, path: document.path };
}

describe('where the document lives', () => {
  it('should be state/security.json inside the state home', async () => {
    // Arrange
    const { paths, path } = await fixture('security-path');

    // Assert
    should(path).equal(`${paths.state}/security.json`);
  });
});

describe('reading', () => {
  it('should answer a missing file as "never written", not as damage', async () => {
    // Arrange
    const { document } = await fixture('security-missing');

    // Act + Assert
    should(await document.read()).be.undefined();
  });

  it('should answer an invalid JSON file as damage, naming the file', async () => {
    // Arrange
    const { document, path } = await fixture('security-bad-json');
    await writeFile(path, '{"schemaVersion": 1, "settings": ');

    // Act
    const read = document.read();

    // Assert
    await should(read).be.rejectedWith(SecuritySettingsDamaged);
    await should(read).be.rejectedWith(new RegExp(`${path.replaceAll('/', '\\/')} is not valid JSON`, 'u'));
  });

  it('should answer a file of the wrong shape as damage, naming the file', async () => {
    // Every one of these is a document somebody edited or a program wrote wrongly.
    // Arrange
    const { document, path } = await fixture('security-bad-shape');
    const wrong: readonly unknown[] = [
      [],
      null,
      'text',
      {},
      { schemaVersion: 2, settings: SETTINGS, updatedAt: UPDATED_AT },
      { schemaVersion: 1, settings: { ...SETTINGS, idleExpiryDays: 91 }, updatedAt: UPDATED_AT },
      { schemaVersion: 1, settings: { ...SETTINGS, unlockOnOpen: 'yes' }, updatedAt: UPDATED_AT },
      { schemaVersion: 1, settings: { idleExpiryDays: 9 }, updatedAt: UPDATED_AT },
      { schemaVersion: 1, settings: SETTINGS },
      { schemaVersion: 1, settings: SETTINGS, updatedAt: 'yesterday' },
      { schemaVersion: 1, settings: SETTINGS, updatedAt: UPDATED_AT, extra: true },
    ];

    // Act + Assert
    for (const value of wrong) {
      await writeFile(path, JSON.stringify(value));
      const error = await document.read().then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      should(error).be.instanceOf(SecuritySettingsDamaged);
      should((error as Error).message).equal(`${path} does not describe security settings`);
      should((error as Error).name).equal('SecuritySettingsDamaged');
    }
  });

  it('should answer an empty file as damage', async () => {
    // Arrange
    const { document, path } = await fixture('security-empty');
    await writeFile(path, '');

    // Act + Assert
    await should(document.read()).be.rejectedWith(SecuritySettingsDamaged);
  });
});

describe('writing', () => {
  it('should write one document at schemaVersion 1, owner-only, ending in a newline', async () => {
    // Arrange
    const { document, path } = await fixture('security-write');

    // Act
    await document.write({ settings: SETTINGS, updatedAt: UPDATED_AT });

    // Assert
    const text = await readFile(path, 'utf8');
    should(text.endsWith('\n')).be.true();
    should(JSON.parse(text)).deepEqual({ schemaVersion: 1, settings: SETTINGS, updatedAt: UPDATED_AT });
    should((await stat(path)).mode & 0o777).equal(0o600);
  });

  it('should round-trip what it wrote', async () => {
    // Arrange
    const { document } = await fixture('security-round-trip');

    // Act
    await document.write({ settings: SETTINGS, updatedAt: UPDATED_AT });
    const first = await document.read();
    await document.write({ settings: DEFAULT_SECURITY_SETTINGS, updatedAt: '2026-10-02T00:00:00.000Z' });
    const second = await document.read();

    // Assert
    should(first).deepEqual({ settings: SETTINGS, updatedAt: UPDATED_AT });
    should(second).deepEqual({ settings: DEFAULT_SECURITY_SETTINGS, updatedAt: '2026-10-02T00:00:00.000Z' });
  });

  it('should replace a damaged document with a readable one', async () => {
    // Arrange
    const { document, path } = await fixture('security-replace-damage');
    await writeFile(path, 'not json');

    // Act
    await document.write({ settings: SETTINGS, updatedAt: UPDATED_AT });

    // Assert
    should(await document.read()).deepEqual({ settings: SETTINGS, updatedAt: UPDATED_AT });
  });

  it('should tighten a looser mode a previous file had, so owner-only is a property of the write', async () => {
    // Arrange
    const { document, path } = await fixture('security-mode');
    await writeFile(path, 'old', { mode: 0o644 });

    // Act
    await document.write({ settings: SETTINGS, updatedAt: UPDATED_AT });

    // Assert
    should((await stat(path)).mode & 0o777).equal(0o600);
  });

  it('should leave no temporary file behind, and replace by rename rather than writing in place', async () => {
    // Arrange
    const { document, paths, files } = await fixture('security-atomic');
    const calls: string[] = [];
    const recording: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'setMode'> = {
      readText: async path => await files.readText(path),
      writeTextAtomic: async (path, text) => {
        calls.push('writeTextAtomic');
        await files.writeTextAtomic(path, text);
      },
      setMode: async (path, mode) => {
        calls.push(`setMode:${mode.toString(8)}`);
        await files.setMode(path, mode);
      },
    };
    const recorded = new StateSecuritySettingsDocument(paths, recording);

    // Act
    await recorded.write({ settings: SETTINGS, updatedAt: UPDATED_AT });
    await document.write({ settings: DEFAULT_SECURITY_SETTINGS, updatedAt: UPDATED_AT });

    // Assert — the atomic write comes first, then the mode, and the document and the state home's own temporary directory are all that is left, and that is empty.
    should(calls).deepEqual(['writeTextAtomic', 'setMode:600']);
    should((await readdir(paths.state)).sort()).deepEqual(['security.json', 'tmp']);
    should(await readdir(paths.temporary)).be.empty();
  });

  it('should refuse to write settings outside the bounds, and leave the file as it was', async () => {
    // Arrange
    const { document, path } = await fixture('security-refuse-write');
    await document.write({ settings: SETTINGS, updatedAt: UPDATED_AT });
    const before = await readFile(path, 'utf8');

    // Act
    const refused = document.write({ settings: { ...SETTINGS, idleExpiryDays: 500 }, updatedAt: UPDATED_AT });

    // Assert
    await should(refused).be.rejected();
    should(await readFile(path, 'utf8')).equal(before);
  });
});
