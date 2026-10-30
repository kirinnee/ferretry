import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FilePendingContext, FileSweepMemory } from '../../../src/adapters/board/file-board-sweep-state.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/index.ts';
import { EMPTY_SWEEP_MEMORY, type QuietItem, type SweepMemory } from '../../../src/lib/board/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/**
 * The board sweep's two small state files over a real state home: its memory (`board/sweep.json`) and
 * each ferret's pending context (`board/pending/<session>.json`). Temp `FY_HOME`; no daemon.
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
    context: () => new FilePendingContext(directory, files, new KeyedSerialExecutor(), diagnostics),
  };
}

async function plant(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

const item = (key: string, text = key): QuietItem => ({ key, text, at: NOW });

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
      seen: { F1: { seq: 3, blockedBy: ['/F9'], waiting: ['lead/A9'] } },
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
});

describe('the pending context files', () => {
  it('should append, coalesce, take everything and keep it across a restart', async () => {
    // Arrange
    const { context } = await fixture();
    await context().append('lead', [item('F1:lane', 'old'), item('F2:lane')]);
    await context().append('lead', [item('F1:lane', 'new')]);

    // Act
    const taken = await context().take('lead');
    const again = await context().take('lead');

    // Assert
    should(taken.map(each => each.text)).eql(['F2:lane', 'new']);
    should(again).eql([]);
  });

  it('should restore what a failed send took ahead of what came since', async () => {
    // Arrange
    const { context } = await fixture();
    const queue = context();
    await queue.append('lead', [item('F1:lane')]);
    const taken = await queue.take('lead');
    await queue.append('lead', [item('F2:lane')]);

    // Act
    await queue.restore('lead', taken);

    // Assert
    should((await queue.take('lead')).map(each => each.key)).eql(['F1:lane', 'F2:lane']);
  });

  it('should keep one file per session, write nothing for nothing, and ignore an id that is not a session', async () => {
    // Arrange
    const { directory, context } = await fixture();
    const queue = context();

    // Act
    await queue.take('lead');
    await queue.append('child', [item('F2:lane')]);
    await queue.append('../escape', [item('F3:lane')]);
    const stranger = await queue.take('../escape');

    // Assert
    should(await readFile(join(directory, 'pending', 'lead.json'), 'utf8').catch(() => 'missing')).equal('missing');
    should(JSON.parse(await readFile(join(directory, 'pending', 'child.json'), 'utf8'))).eql({
      v: 1,
      items: [item('F2:lane')],
    });
    should(stranger).eql([]);
  });

  it('should drop a damaged file, say so, and keep working', async () => {
    // Arrange
    const { directory, context, warnings } = await fixture();
    await plant(join(directory, 'pending', 'lead.json'), 'garbage');

    // Act
    const taken = await context().take('lead');
    await context().append('lead', [item('F1:lane')]);

    // Assert
    should(taken).eql([]);
    should(warnings).eql(["the board's pending context for lead is damaged; dropping it"]);
    should((await context().take('lead')).map(each => each.key)).eql(['F1:lane']);
  });
});
