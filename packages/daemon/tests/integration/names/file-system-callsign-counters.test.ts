import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileSystemCallsignCounters } from '../../../src/adapters/names/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/**
 * The system-callsign counters over a real state home: what a restart reads back, and that a missing or
 * damaged document reads as "nothing issued yet" rather than failing a system session's start.
 */

const homes = new Set<string>();

async function fixture(): Promise<{ readonly file: string; readonly counters: FileSystemCallsignCounters }> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-system-callsigns-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const file = join(paths.state, 'system-callsigns.json');
  return { file, counters: new FileSystemCallsignCounters(file, new StateFileSystem(paths)) };
}

async function plant(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('FileSystemCallsignCounters', () => {
  it('should read nothing issued yet before the first write', async () => {
    // Arrange
    const { counters } = await fixture();

    // Act
    const read = await counters.read();

    // Assert
    should(read).deepEqual({});
  });

  it('should read back what it wrote, as one JSON document', async () => {
    // Arrange
    const { file, counters } = await fixture();

    // Act
    await counters.write({ learning: 3, pack: 0xff_ff_ff });
    const read = await counters.read();

    // Assert
    should(read).deepEqual({ learning: 3, pack: 0xff_ff_ff });
    should(await readFile(file, 'utf8')).equal('{"learning":3,"pack":16777215}\n');
  });

  it('should read a document that is not JSON as nothing issued yet', async () => {
    // Arrange
    const { file, counters } = await fixture();
    await plant(file, '{"learning": 3');

    // Act
    const read = await counters.read();

    // Assert
    should(read).deepEqual({});
  });

  it('should read JSON that is not an object as nothing issued yet', async () => {
    // Arrange
    const { file, counters } = await fixture();
    await plant(file, 'null\n');

    // Act
    const read = await counters.read();

    // Assert
    should(read).deepEqual({});
  });

  it('should keep each valid counter and drop the damaged ones and unknown prefixes', async () => {
    // Arrange
    const { file, counters } = await fixture();
    await plant(file, JSON.stringify({ learning: 7, pack: -1, warden: 4, other: 2 }));

    // Act
    const read = await counters.read();

    // Assert
    should(read).deepEqual({ learning: 7, warden: 4 });
  });
});
