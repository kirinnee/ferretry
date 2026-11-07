import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileLoopbackMarkerReader } from '../../../../src/adapters/browser/firewall/marker-reader.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'fy-loopback-marker-'));
  directories.push(directory);
  return directory;
};

const marker = {
  version: 1,
  appliedAt: '2026-10-31T01:02:03.000Z',
  base: 20000,
  entries: [{ uid: 1001, ports: [20004, 20005, 20006] }],
};

describe('loopback firewall marker reader', () => {
  it('should read the marker file the root script left', async () => {
    // Arrange
    const path = join(await temporary(), 'loopback-firewall.json');
    await writeFile(path, JSON.stringify(marker));

    // Act
    const value = await new FileLoopbackMarkerReader(path).read();

    // Assert
    should(value).eql(marker);
  });

  it('should answer undefined for a missing file, text that is not JSON, and JSON that is not a marker', async () => {
    // Arrange
    const directory = await temporary();
    const garbled = join(directory, 'garbled.json');
    const other = join(directory, 'other.json');
    await writeFile(garbled, '{ not json');
    await writeFile(other, JSON.stringify({ version: 2 }));

    // Act + Assert
    should(await new FileLoopbackMarkerReader(join(directory, 'absent.json')).read()).equal(undefined);
    should(await new FileLoopbackMarkerReader(garbled).read()).equal(undefined);
    should(await new FileLoopbackMarkerReader(other).read()).equal(undefined);
  });
});
