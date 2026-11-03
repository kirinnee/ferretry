import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardQuerySchema, BoardTaskSchema } from '@ferretry/protocol';
import should from 'should';
import { FileBoardStore } from '../../../src/adapters/board/file-board-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/index.ts';
import { BoardService, type OwnerWords } from '../../../src/lib/board/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { card, world } from '../../unit/board/support.ts';

/**
 * The visibility migration over a real state home: the cards on disk, a "restart" as a fresh service over a fresh
 * store, and the public query reading what was persisted. Temp `FY_HOME`; no daemon, no port.
 */

const homes = new Set<string>();
const OWNER_SAID = 'Make the inbox show only cards a person asked for, with the project name next to the machine';

class Words implements OwnerWords {
  failing = true;
  async said(): Promise<readonly string[]> {
    if (this.failing) throw new Error('queue torn');
    return [OWNER_SAID];
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-visibility-migration-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const directory = join(paths.state, 'board');
  const tasks = join(directory, 'tasks');
  const words = new Words();
  const boot = () => {
    const store = new FileBoardStore(directory, new StateFileSystem(paths), new KeyedSerialExecutor(), {
      warn: () => {},
    });
    return new BoardService({ ...world(), store, ownerWords: words });
  };
  const plant = async (...cards: ReturnType<typeof card>[]) => {
    await mkdir(tasks, { recursive: true });
    for (const entry of cards) await writeFile(join(tasks, `${entry.id}.json`), `${JSON.stringify(entry)}\n`);
  };
  const onDisk = async (id: string) =>
    BoardTaskSchema.parse(JSON.parse(await readFile(join(tasks, `${id}.json`), 'utf8')));
  const publicIds = async (service: BoardService) =>
    (await service.board(BoardQuerySchema.parse({ visibility: 'public' }))).cards.map(entry => entry.id).sort();
  return { boot, plant, onDisk, publicIds, words };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the visibility migration over the file board store', () => {
  it('should persist each settled default, leave a chosen value alone, and do nothing on the next boot', async () => {
    // Arrange
    const { boot, plant, onDisk, publicIds } = await fixture();
    await plant(
      card({ id: 'F1', ask: { text: 'build it', source: 'owner (board)' }, askedBy: 'person' }),
      card({ id: 'F2', ask: { text: 'an idea', source: 'session:lead' }, askedBy: 'agent' }),
      card({ id: 'F3', askedBy: 'agent', visibility: 'public', visibilitySource: 'chosen' }),
    );

    // Act
    const first = await boot().backfillVisibility();
    const restarted = boot();
    const second = await restarted.backfillVisibility();

    // Assert
    should(first).equal(2);
    should(second).equal(0);
    should(await onDisk('F1')).match({ visibility: 'public', visibilitySource: 'default' });
    should(await onDisk('F2')).match({ visibility: 'private', visibilitySource: 'default' });
    should(await onDisk('F3')).match({ visibility: 'public', visibilitySource: 'chosen' });
    should(await publicIds(restarted)).eql(['F1', 'F3']);
  });

  it('should publish an owner ask once its asker is settled on a later boot', async () => {
    // Arrange
    const { boot, plant, onDisk, publicIds, words } = await fixture();
    await plant(card({ id: 'F1', ask: { text: OWNER_SAID, source: 'session:lead' } }));

    // Act
    const firstBoot = boot();
    await firstBoot.backfillAskedBy();
    await firstBoot.backfillVisibility();
    const hidden = await publicIds(firstBoot);
    words.failing = false;
    const secondBoot = boot();
    await secondBoot.backfillAskedBy();
    await secondBoot.backfillVisibility();

    // Assert
    should(hidden).eql([]);
    should(await onDisk('F1')).match({ askedBy: 'person', visibility: 'public', visibilitySource: 'default' });
    should(await publicIds(secondBoot)).eql(['F1']);
  });
});
