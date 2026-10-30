import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LegacyWireUse } from '@ferretry/protocol';
import should from 'should';
import { FileLegacyWireUseStore, systemLegacyWireTimers } from '../../../src/adapters/api/index.ts';

const USE: LegacyWireUse = {
  route: 'GET /v1/warden/attention',
  firstAt: '2026-10-01T00:00:00.000Z',
  lastAt: '2026-10-02T00:00:00.000Z',
  count: 2,
  lastClientVersion: '4.1.0',
};

async function home(): Promise<{ readonly directory: string; readonly file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-legacy-wire-'));
  return { directory, file: join(directory, 'legacy-wire-use.json') };
}

describe('the legacy-wire use file', () => {
  it('should round-trip a saved counter through a 0600 file', async () => {
    // Arrange
    const { directory, file } = await home();
    const warnings: string[] = [];
    const subject = new FileLegacyWireUseStore(file, { warn: message => warnings.push(message) });

    // Act
    await subject.save([USE]);
    const loaded = await subject.load();

    // Assert
    should(loaded).deepEqual([USE]);
    should((await stat(file)).mode & 0o777).equal(0o600);
    should(warnings).deepEqual([]);
    await rm(directory, { recursive: true, force: true });
  });

  it('should create the home it is saved into', async () => {
    // Arrange
    const { directory } = await home();
    const file = join(directory, 'nested', 'legacy-wire-use.json');

    // Act
    await new FileLegacyWireUseStore(file, { warn: () => {} }).save([USE]);

    // Assert
    should(JSON.parse(await readFile(file, 'utf8'))).deepEqual({ v: 1, uses: [USE] });
    await rm(directory, { recursive: true, force: true });
  });

  it('should treat a missing file as an empty counter without a word', async () => {
    // Arrange
    const { directory, file } = await home();
    const warnings: string[] = [];

    // Act
    const loaded = await new FileLegacyWireUseStore(file, { warn: message => warnings.push(message) }).load();

    // Assert
    should(loaded).deepEqual([]);
    should(warnings).deepEqual([]);
    await rm(directory, { recursive: true, force: true });
  });

  it('should say a damaged file is being reset, and let the next save replace it', async () => {
    // Arrange
    const { directory, file } = await home();
    const warnings: string[] = [];
    const subject = new FileLegacyWireUseStore(file, { warn: message => warnings.push(message) });
    await writeFile(file, '{ not json');

    // Act
    const loaded = await subject.load();
    await subject.save([USE]);

    // Assert
    should(loaded).deepEqual([]);
    should(warnings).have.length(1);
    should(warnings[0]).match(/starts again/u);
    should(await subject.load()).deepEqual([USE]);
    await rm(directory, { recursive: true, force: true });
  });

  it('should say a file of the wrong shape is being reset', async () => {
    // Arrange
    const { directory, file } = await home();
    const warnings: string[] = [];
    await writeFile(file, JSON.stringify({ v: 2, uses: [] }));

    // Act
    const loaded = await new FileLegacyWireUseStore(file, { warn: message => warnings.push(message) }).load();

    // Assert
    should(loaded).deepEqual([]);
    should(warnings).have.length(1);
    await rm(directory, { recursive: true, force: true });
  });

  it('should say an unreadable path is being reset rather than failing', async () => {
    // Arrange
    const { directory, file } = await home();
    await mkdir(file);
    const warnings: string[] = [];

    // Act
    const loaded = await new FileLegacyWireUseStore(file, { warn: message => warnings.push(message) }).load();

    // Assert
    should(loaded).deepEqual([]);
    should(warnings).have.length(1);
    await rm(directory, { recursive: true, force: true });
  });
});

describe('the host timers', () => {
  it('should tell the time and run a timer that was not cancelled', async () => {
    // Arrange / Act
    const before = Date.now();
    const ran = await new Promise<boolean>(resolve => {
      systemLegacyWireTimers.after(1, () => resolve(true));
    });

    // Assert
    should(ran).be.true();
    should(systemLegacyWireTimers.now()).be.aboveOrEqual(before);
  });

  it('should not run a timer that was cancelled', async () => {
    // Arrange
    let ran = false;

    // Act
    const cancel = systemLegacyWireTimers.after(5, () => {
      ran = true;
    });
    cancel();
    await new Promise(resolve => setTimeout(resolve, 20));

    // Assert
    should(ran).be.false();
  });
});
