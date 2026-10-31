import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardTaskSchema } from '@ferretry/protocol';
import should from 'should';
import { FileBoardStore } from '../../../src/adapters/board/file-board-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/index.ts';
import { BoardUnavailableError } from '../../../src/lib/board/index.ts';
import { createFoundationPaths, type FileSystemPort, resolveStateHome } from '../../../src/lib/index.ts';
import { card } from '../../unit/board/support.ts';

/**
 * The board's source of truth over a real state home: one file per card, a machine-wide counter, and a
 * damaged card quarantined instead of failing the board. Temp `FY_HOME`; no daemon, no port.
 */

const homes = new Set<string>();

async function fixture(wrap: (files: FileSystemPort) => FileSystemPort = files => files) {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-board-store-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const directory = join(paths.state, 'board');
  const files = wrap(new StateFileSystem(paths));
  const warnings: string[] = [];
  const open = () =>
    new FileBoardStore(directory, files, new KeyedSerialExecutor(), { warn: message => warnings.push(message) });
  return { directory, tasks: join(directory, 'tasks'), open, store: open(), warnings };
}

async function plant(directory: string, name: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), text);
}

const json = (value: unknown) => `${JSON.stringify(value)}\n`;

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the file board store', () => {
  it('should read an empty board before anything is written', async () => {
    // Arrange
    const { store } = await fixture();

    // Act
    const snapshot = await store.read();

    // Assert
    should(snapshot).eql({ cards: [], quarantined: [] });
  });

  it('should write one file per card that a fresh store reads back', async () => {
    // Arrange
    const { tasks, store, open } = await fixture();

    // Act
    await store.write('F1', async current => ({ task: card(), result: current }));
    await store.write('F2', async () => ({ task: card({ id: 'F2' }), result: undefined }));
    const reread = await open().read();

    // Assert
    should((await readdir(tasks)).sort()).eql(['F1.json', 'F2.json']);
    should(BoardTaskSchema.parse(JSON.parse(await readFile(join(tasks, 'F1.json'), 'utf8')))).eql(card());
    should(reread.cards.map(entry => entry.id).sort()).eql(['F1', 'F2']);
  });

  it('should hand the decision the stored card and store nothing when it says so', async () => {
    // Arrange
    const { store } = await fixture();
    await store.write('F1', async () => ({ task: card(), result: undefined }));

    // Act
    const seen = await store.write('F1', async current => ({ task: null, result: current?.title }));

    // Assert
    should(seen).equal('Board store');
    should((await store.read()).cards).eql([card()]);
  });

  it('should serialize writes to one card so neither is lost', async () => {
    // Arrange
    const { store, open } = await fixture();
    await store.write('F1', async () => ({ task: card(), result: undefined }));
    const append = (text: string) =>
      store.write('F1', async current => {
        const base = current ?? card();
        const event = {
          seq: base.history.length + 1,
          at: base.createdAt,
          actor: { kind: 'owner' as const },
          type: 'note' as const,
          text,
        };
        return { task: { ...base, history: [...base.history, event] }, result: undefined };
      });

    // Act
    await Promise.all([append('one'), append('two'), append('three')]);
    const stored = (await open().read()).cards[0];

    // Assert
    should(stored?.history.map(event => event.type)).eql(['created', 'note', 'note', 'note']);
  });

  it('should refuse a card that does not match its file name or the schema', async () => {
    // Arrange
    const { store } = await fixture();

    // Act
    const misnamed = await store
      .write('F1', async () => ({ task: card({ id: 'F2' }), result: undefined }))
      .catch((error: unknown) => error);
    const invalid = await store
      .write('F1', async () => ({ task: { ...card(), history: [] }, result: undefined }))
      .catch((error: unknown) => error);

    // Assert
    should(misnamed).be.instanceOf(BoardUnavailableError);
    should(invalid).be.instanceOf(Error);
    should((await store.read()).cards).eql([]);
  });

  it('should quarantine damaged cards, serve the rest and refuse to overwrite the damage', async () => {
    // Arrange
    const { tasks, store, warnings } = await fixture();
    await plant(tasks, 'F1.json', json(card()));
    await plant(tasks, 'F2.json', '{"half": ');
    await plant(tasks, 'F3.json', json({ ...card({ id: 'F3' }), laneId: 'Not A Lane' }));
    await plant(tasks, 'F4.json', json(card({ id: 'F1' })));
    await plant(tasks, 'notes.txt', 'not a card');
    await mkdir(join(tasks, 'F5.json'));

    // Act
    const snapshot = await store.read();
    const overwrite = await store
      .write('F2', async () => ({ task: card({ id: 'F2' }), result: undefined }))
      .catch((error: unknown) => error);
    const next = await store.allocateId('feature');

    // Assert
    should(snapshot.cards.map(entry => entry.id)).eql(['F1']);
    should(snapshot.quarantined.map(entry => entry.id).sort()).eql(['F2', 'F3', 'F4']);
    should(snapshot.quarantined.find(entry => entry.id === 'F2')?.reason).equal('the card file is not valid JSON');
    should(snapshot.quarantined.find(entry => entry.id === 'F3')?.reason).startWith(
      'the card does not match the board schema (laneId: ',
    );
    should(snapshot.quarantined.find(entry => entry.id === 'F4')?.reason).equal(
      'the file is named F4 but holds card F1',
    );
    should(snapshot.quarantined.every(entry => !entry.reason.includes(tasks))).be.true();
    should(warnings.length).equal(3);
    should(overwrite).be.instanceOf(BoardUnavailableError);
    should(await readFile(join(tasks, 'F2.json'), 'utf8')).equal('{"half": ');
    should(next).equal('F5');
  });

  it('should count per kind, never reuse an id, and keep the counter on disk', async () => {
    // Arrange
    const { directory, tasks, store, open } = await fixture();
    await plant(tasks, 'F7.json', json(card({ id: 'F7' })));

    // Act
    const ids = [await store.allocateId('feature'), await store.allocateId('bug'), await store.allocateId('feature')];
    const afterRestart = await open().allocateId('feature');

    // Assert
    should(ids).eql(['F8', 'B1', 'F9']);
    should(afterRestart).equal('F10');
    should(JSON.parse(await readFile(join(directory, 'counters.json'), 'utf8'))).eql({ F: 10, B: 1 });
  });

  it('should continue from the cards on disk when the counter is damaged', async () => {
    // Arrange
    const { directory, tasks, store, warnings } = await fixture();
    await plant(tasks, 'C3.json', json(card({ id: 'C3', kind: 'chore' })));
    await plant(directory, 'counters.json', 'garbage');

    // Act
    const id = await store.allocateId('chore');

    // Assert
    should(id).equal('C4');
    should(warnings).eql(['the board id counter is damaged; continuing from the highest id on disk']);
  });

  it('should refuse an exhausted counter', async () => {
    // Arrange
    const { directory, store } = await fixture();
    await plant(directory, 'counters.json', json({ I: 999_999_999 }));

    // Act
    const error = await store.allocateId('infra').catch((thrown: unknown) => thrown);

    // Assert
    should(error).be.instanceOf(BoardUnavailableError);
  });

  it('should skip a card file that vanished between the listing and the read', async () => {
    // Arrange
    const { store } = await fixture(files =>
      Object.assign(Object.create(files) as FileSystemPort, {
        listDirectory: async () => [{ name: 'F1.json', directory: false, regularFile: true }],
        readText: async (path: string) => (path.endsWith('F1.json') ? undefined : await files.readText(path)),
      }),
    );

    // Act
    const snapshot = await store.read();

    // Assert
    should(snapshot).eql({ cards: [], quarantined: [] });
  });

  it('should retry the first read after it failed instead of caching the failure', async () => {
    // Arrange
    let failures = 1;
    const { store } = await fixture(files =>
      Object.assign(Object.create(files) as FileSystemPort, {
        listDirectory: async (path: string) => {
          if (failures-- > 0) throw new Error('EIO');
          return await files.listDirectory(path);
        },
      }),
    );

    // Act
    const first = await store.read().catch((error: unknown) => error);
    const second = await store.read();

    // Assert
    should(first).be.instanceOf(Error);
    should(second.cards).eql([]);
  });
});

describe('the file board store, edited outside the daemon', () => {
  it('should notice a card file changed by hand and read its new words', async () => {
    // Arrange
    const { tasks, store } = await fixture();
    await store.write('F1', async () => ({ task: card({ title: 'Board store' }), result: undefined }));
    await store.write('F2', async () => ({ task: card({ id: 'F2', title: 'Lane sets' }), result: undefined }));
    const before = (await store.read()).cards.find(entry => entry.id === 'F2');

    // Act
    await writeFile(join(tasks, 'F1.json'), json(card({ title: 'Relay carrier', summary: 'edited by hand' })));
    const changed = await store.noticeOutsideEdits();
    const after = await store.read();

    // Assert
    should(changed).eql(['F1']);
    should(after.cards.find(entry => entry.id === 'F1')).match({ title: 'Relay carrier', summary: 'edited by hand' });
    // An untouched card keeps its object: nothing downstream re-derives it.
    should(after.cards.find(entry => entry.id === 'F2')).equal(before);
  });

  it('should not count its own writes as outside edits', async () => {
    // Arrange
    const { store } = await fixture();
    await store.write('F1', async () => ({ task: card(), result: undefined }));
    await store.read();

    // Act
    await store.write('F1', async () => ({ task: card({ title: 'Renamed here' }), result: undefined }));

    // Assert
    should(await store.noticeOutsideEdits()).eql([]);
  });

  it('should pick up a card file added by hand, and drop one removed by hand', async () => {
    // Arrange
    const { tasks, store } = await fixture();
    await store.write('F1', async () => ({ task: card(), result: undefined }));
    await store.read();

    // Act
    await writeFile(join(tasks, 'F7.json'), json(card({ id: 'F7', title: 'Restored from backup' })));
    await rm(join(tasks, 'F1.json'));
    const changed = await store.noticeOutsideEdits();

    // Assert
    should([...changed].sort()).eql(['F1', 'F7']);
    should((await store.read()).cards.map(entry => entry.id)).eql(['F7']);
  });

  it('should quarantine a hand edit that no longer parses, as a boot would', async () => {
    // Arrange
    const { tasks, store, warnings } = await fixture();
    await store.write('F1', async () => ({ task: card(), result: undefined }));
    await store.read();

    // Act
    await writeFile(join(tasks, 'F1.json'), '{ not json');
    await store.noticeOutsideEdits();
    const snapshot = await store.read();

    // Assert
    should(snapshot.cards).eql([]);
    should(snapshot.quarantined.map(entry => entry.id)).eql(['F1']);
    should(warnings.join('\n')).containEql('F1');
  });

  it('should scan when its directory says it changed', async () => {
    // Arrange
    const { tasks, store } = await fixture();
    await store.write('F1', async () => ({ task: card(), result: undefined }));
    await store.read();
    let fire = () => undefined as void;
    let watched = '';
    store.watch((directory, listener) => {
      watched = directory;
      fire = listener;
      return { close: () => undefined };
    });

    // Act
    await writeFile(join(tasks, 'F1.json'), json(card({ title: 'Heard through the watch' })));
    fire();
    await store.noticeOutsideEdits();

    // Assert
    should(watched).equal(tasks);
    should((await store.read()).cards[0]?.title).equal('Heard through the watch');
  });
});
