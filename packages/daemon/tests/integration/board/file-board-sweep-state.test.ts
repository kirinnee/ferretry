import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSweepMemory } from '../../../src/adapters/board/file-board-sweep-state.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { EMPTY_SWEEP_MEMORY, type SweepMemory } from '../../../src/lib/board/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/**
 * The board sweep's memory (`board/sweep.json`) over a real state home. Temp `FY_HOME`; no daemon.
 */

const homes = new Set<string>();
const NOW = '2026-10-30T10:00:00.000Z';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-board-sweep-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const directory = join(paths.state, 'board');
  const files = new StateFileSystem(paths);
  const warnings: string[] = [];
  const diagnostics = { warn: (message: string) => warnings.push(message) };
  return {
    directory,
    warnings,
    memory: () => new FileSweepMemory(directory, files, diagnostics),
  };
}

async function plant(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the board sweep memory file', () => {
  it('should start empty and read back what was written, across a restart', async () => {
    // Arrange
    const { memory } = await fixture();
    const written: SweepMemory = {
      v: 1,
      sweptAt: NOW,
      nudged: { F1: NOW },
      seen: { F1: { blockedBy: ['/F9'] } },
    };

    // Act
    const before = await memory().read();
    await memory().write(written);
    const after = await memory().read();

    // Assert
    should(before).eql(EMPTY_SWEEP_MEMORY);
    should(after).eql(written);
  });

  it('should start again, and say so, when the file is damaged', async () => {
    // Arrange
    const { directory, memory, warnings } = await fixture();
    await plant(join(directory, 'sweep.json'), '{ not json');

    // Act
    const read = await memory().read();
    await plant(join(directory, 'sweep.json'), '{"v":2}');
    const wrongShape = await memory().read();

    // Assert
    should(read).eql(EMPTY_SWEEP_MEMORY);
    should(wrongShape).eql(EMPTY_SWEEP_MEMORY);
    should(warnings).have.length(2);
  });

  it('should read a memory written when the sweep also kept history positions and asks, keeping the blockers', async () => {
    // Arrange
    const { directory, memory, warnings } = await fixture();
    const older = {
      v: 1,
      sweptAt: NOW,
      nudged: {},
      seen: { F1: { seq: 3, blockedBy: ['/F9'], waiting: ['lead/A9'] } },
    };
    await plant(join(directory, 'sweep.json'), JSON.stringify(older));

    // Act
    const read = await memory().read();

    // Assert
    should(read).eql({ v: 1, sweptAt: NOW, nudged: {}, seen: { F1: { blockedBy: ['/F9'] } } });
    should(warnings).eql([]);
  });
});
