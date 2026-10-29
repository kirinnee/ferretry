import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { ProcIoPressureReader } from '../../../src/adapters/daemon/io-pressure';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })),
  );
});

async function psiFile(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fy-psi-'));
  directories.push(directory);
  const path = join(directory, 'io');
  await writeFile(path, text);
  return path;
}

describe('ProcIoPressureReader', () => {
  it('should read a pressure file at the injected path', async () => {
    // Arrange
    const path = await psiFile(
      'some avg10=52.00 avg60=51.00 avg300=51.00 total=1\nfull avg10=46.00 avg60=45.00 avg300=44.00 total=1\n',
    );

    // Act
    const actual = await new ProcIoPressureReader(path).read();

    // Assert
    should(actual?.full?.avg10).equal(46);
    should(actual?.some.avg10).equal(52);
  });

  it('should answer undefined for a missing file and for text it cannot read, never throwing', async () => {
    // Arrange
    const garbled = await psiFile('nonsense');

    // Act / Assert
    should(await new ProcIoPressureReader('/nonexistent/pressure/io').read()).be.undefined();
    should(await new ProcIoPressureReader(garbled).read()).be.undefined();
  });

  it('should read the real file on the host without throwing, where one exists', async () => {
    // Act
    const actual = await new ProcIoPressureReader().read();

    // Assert — present on a PSI kernel, absent elsewhere; either way a value or undefined.
    should(actual === undefined || typeof actual.some.avg10 === 'number').be.true();
  });
});
