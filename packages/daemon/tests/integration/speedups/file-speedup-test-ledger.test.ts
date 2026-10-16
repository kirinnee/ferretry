import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSpeedupTestLedger, type SpeedupLedgerFiles } from '../../../src/adapters/index.ts';

/** The ledger over a real directory, through the two calls it makes on the state home's filesystem. */

const files: SpeedupLedgerFiles = {
  readText: async path => await readFile(path, 'utf8').catch(() => undefined),
  writeTextAtomic: async (path, text) => await writeFile(path, text),
};

async function withDirectory(act: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fy-speedups-'));
  try {
    await act(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the file speed-up test ledger', () => {
  it('should write pretty JSON and read it back', async () => {
    await withDirectory(async directory => {
      // Arrange
      const ledger = new FileSpeedupTestLedger(files, join(directory, 'speedups.json'));

      // Act
      await ledger.write({ v: 1, results: {} });
      const actual = await ledger.read();

      // Assert
      should(actual).deepEqual({ v: 1, results: {} });
      should(await readFile(join(directory, 'speedups.json'), 'utf8')).equal('{\n  "v": 1,\n  "results": {}\n}\n');
    });
  });

  it('should read an absent, blank, non-JSON or unreadable document as undefined', async () => {
    await withDirectory(async directory => {
      // Arrange
      await writeFile(join(directory, 'blank.json'), '  \n');
      await writeFile(join(directory, 'garbage.json'), '{not json');
      const failing: SpeedupLedgerFiles = {
        readText: async () => {
          throw new Error('EACCES');
        },
        writeTextAtomic: files.writeTextAtomic,
      };

      // Act
      const actual = [
        await new FileSpeedupTestLedger(files, join(directory, 'absent.json')).read(),
        await new FileSpeedupTestLedger(files, join(directory, 'blank.json')).read(),
        await new FileSpeedupTestLedger(files, join(directory, 'garbage.json')).read(),
        await new FileSpeedupTestLedger(failing, join(directory, 'absent.json')).read(),
      ];

      // Assert
      should(actual).deepEqual([undefined, undefined, undefined, undefined]);
    });
  });
});
