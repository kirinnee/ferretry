import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { ProcIoPressure } from '../../../src/adapters/system/proc-io-pressure.ts';
import { waitFor } from '../support/wait-for.ts';

const BUSY = 'some avg10=52.00 avg60=51.00 avg300=51.00 total=1\nfull avg10=46.00 avg60=45.00 avg300=44.00 total=1\n';
const CALM = 'some avg10=0.50 avg60=0.40 avg300=0.30 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n';

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

describe('ProcIoPressure', () => {
  it('should report nothing until the file has been read, then what it said', async () => {
    // Arrange
    const pressure = new ProcIoPressure(await psiFile(BUSY));

    // Act
    const before = pressure.current();
    await pressure.refresh();

    // Assert
    should(before).be.undefined();
    should(pressure.current()?.full?.avg10).equal(46);
  });

  it('should follow the file as the disk calms, and drop the reading when the file goes', async () => {
    // Arrange
    const path = await psiFile(BUSY);
    const pressure = new ProcIoPressure(path);
    await pressure.refresh();

    // Act
    await writeFile(path, CALM);
    await pressure.refresh();
    const calm = pressure.current();
    await rm(path);
    await pressure.refresh();

    // Assert
    should(calm?.some.avg10).equal(0.5);
    should(pressure.current()).be.undefined();
  });

  it('should hold no reading for text it cannot parse and never throw', async () => {
    // Arrange
    const pressure = new ProcIoPressure(await psiFile('garbage'));

    // Act / Assert
    await pressure.refresh();
    should(pressure.current()).be.undefined();
  });

  it('should refresh on its timer after start, and stop when told', async () => {
    // Arrange
    const path = await psiFile(BUSY);
    const pressure = new ProcIoPressure(path, 10);

    // Act
    const stop = pressure.start();
    await waitFor(() => pressure.current()?.full?.avg10 === 46, 'the timer to refresh the first reading');
    const first = pressure.current();
    await writeFile(path, CALM);
    await waitFor(() => pressure.current()?.some.avg10 === 0.5, 'the timer to follow the file to calm');
    const second = pressure.current();
    stop();
    await writeFile(path, BUSY);
    // Negative wait: nothing may read after stop. 50 ms is five 10 ms periods; a late timer could only make
    // this fail, never pass falsely, so a short settle is safe.
    await Bun.sleep(50);
    const afterStop = pressure.current();

    // Assert
    should(first?.full?.avg10).equal(46);
    should(second?.some.avg10).equal(0.5);
    should(afterStop?.some.avg10).equal(0.5);
  });
});
