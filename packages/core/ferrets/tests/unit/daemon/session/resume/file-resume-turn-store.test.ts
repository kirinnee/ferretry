import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import type { RootHandle } from '@ferretry/kernel/contract';
import {
  FileResumeTurnStore,
  TURN_MARKERS,
} from '../../../../../daemon/adapters/session/resume/file-resume-turn-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * The turn documents and completion markers of ONE ferret, on the internal `sessions` root, on a real disk
 * (`state/ferrets/sessions/<ferret>/turns/turn-NNN.md`). Fixture values only.
 */

const FERRET = parseSessionId('mw7bp88g-50e00159');
const OTHER = parseSessionId('mw7bp88g-0badf00d');
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function subject(ferret = FERRET) {
  const parent = await mkdtemp(`${tmpdir()}/fy-turns-`);
  dirs.push(parent);
  const disk = await diskSessionsRoot(parent, ferret);
  return { ...disk, store: new FileResumeTurnStore(disk.root, ferret) };
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;

describe('the resume turn store keeps a ferret’s turns on its own private folder', () => {
  test('a numbered turn is written durably at turns/turn-NNN.md, 0600, inside the 0700 ferret folder', async () => {
    const { store, folder } = await subject();

    const file = await store.writeTurn(FERRET, 4, 'Continue the assigned task.\n');

    expect(file).toBe(`${folder}/turns/turn-004.md`);
    expect(await readFile(file, 'utf8')).toBe('Continue the assigned task.\n');
    expect(await mode(file)).toBe(0o600);
    expect(await mode(folder)).toBe(0o700);
  });

  test('F-0002 who a turn is from sits BESIDE it as turn-NNN.by.json and is never written into the document', async () => {
    const { store, folder } = await subject();

    await store.writeTurn(FERRET, 2, 'Pick the branch up again.\n', { kind: 'ferretry', feature: 'Warden' });

    expect(await readFile(`${folder}/turns/turn-002.md`, 'utf8')).toBe('Pick the branch up again.\n');
    expect(JSON.parse(await readFile(`${folder}/turns/turn-002.by.json`, 'utf8'))).toEqual({
      kind: 'ferretry',
      feature: 'Warden',
    });
    expect(await mode(`${folder}/turns/turn-002.by.json`)).toBe(0o600);
    // A turn with no author records none: the app then reads the words alone.
    await store.writeTurn(FERRET, 3, 'Next.\n');
    await expect(stat(`${folder}/turns/turn-003.by.json`)).rejects.toThrow();
  });

  test('an exact replay of a turn is proved in place, not rewritten: the agent keeps reading the same file', async () => {
    const { store, folder } = await subject();
    await store.writeTurn(FERRET, 2, 'The same words.\n');
    const before = (await stat(`${folder}/turns/turn-002.md`)).ino;

    await store.writeTurn(FERRET, 2, 'The same words.\n');

    expect((await stat(`${folder}/turns/turn-002.md`)).ino).toBe(before);
    // Different words for the same number are a new document.
    await store.writeTurn(FERRET, 2, 'Other words.\n');
    expect(await readFile(`${folder}/turns/turn-002.md`, 'utf8')).toBe('Other words.\n');
  });

  for (const marker of TURN_MARKERS) {
    const rows = marker === 'done' ? 'F-0305 F-0322' : marker === 'needs-help' ? 'F-0305 F-0329' : 'F-0305';
    test(`${rows} clearMarkers removes ${marker}.marker from the ferret folder, and tolerates one never written`, async () => {
      const { store, folder } = await subject();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(`${folder}/${marker}.marker`, `${marker}\n`);

      await store.clearMarkers(FERRET);
      await store.clearMarkers(FERRET);

      await expect(stat(`${folder}/${marker}.marker`)).rejects.toThrow();
    });
  }

  test('F-0305 a link at a marker’s name that leads out of the folder is refused, and what it points at is kept', async () => {
    const { store, folder } = await subject();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const elsewhere = `${folder}/../keep-me`;
    await writeFile(elsewhere, 'kept\n');
    await symlink(elsewhere, `${folder}/done.marker`);

    // The kernel's fence: nothing outside the ferret's folder is reached through a link, so the revive fails closed.
    await expect(store.clearMarkers(FERRET)).rejects.toThrow('link_escape');

    expect(await readFile(elsewhere, 'utf8')).toBe('kept\n');
    expect((await lstat(`${folder}/done.marker`)).isSymbolicLink()).toBe(true);
  });

  test('every turn reads back oldest first with its author; a best-effort read skips an author that does not parse', async () => {
    const { store, folder } = await subject();
    await store.writeTurn(FERRET, 10, 'ten\n', { kind: 'owner' });
    await store.writeTurn(FERRET, 2, 'two\n');
    await writeFile(`${folder}/turns/turn-002.by.json`, '{ not json');
    await writeFile(`${folder}/turns/notes.md`, 'not a turn\n');

    expect(await store.list(FERRET, { strict: false })).toEqual([
      { turn: 2, text: 'two\n' },
      { turn: 10, text: 'ten\n', by: { kind: 'owner' } },
    ]);
    expect(await store.latest(FERRET)).toBe(10);
  });

  test('a STRICT read rejects an author record that does not parse, naming the file and quoting none of it', async () => {
    const { store, folder } = await subject();
    await store.writeTurn(FERRET, 2, 'two\n');
    await writeFile(`${folder}/turns/turn-002.by.json`, '{"kind":"FIXTURE_SECRET"}');

    const read = store.list(FERRET, { strict: true });

    await expect(read).rejects.toThrow('turn-002.by.json');
    await read.catch((error: unknown) => expect(String(error)).not.toContain('FIXTURE_SECRET'));
  });

  test('a ferret with no turn yet reads as none', async () => {
    const { store } = await subject();

    expect(await store.list(FERRET, { strict: true })).toEqual([]);
    expect(await store.latest(FERRET)).toBe(0);
  });

  test('one handle is one ferret: a call that names another ferret is refused and writes nothing', async () => {
    const { store, folder } = await subject();

    expect(() => store.file(OTHER, 2)).toThrow(`through the folder of ${FERRET}`);
    await expect(store.writeTurn(OTHER, 2, 'x')).rejects.toThrow(`through the folder of ${FERRET}`);
    await expect(store.clearMarkers(OTHER)).rejects.toThrow(`through the folder of ${FERRET}`);
    await expect(store.list(OTHER, { strict: false })).rejects.toThrow(`through the folder of ${FERRET}`);
    await expect(stat(`${folder}/turns`)).rejects.toThrow();
  });

  test('a turn store is never built on an owner root such as work', () => {
    const work = { name: 'work', internal: false } as unknown as RootHandle;
    expect(() => new FileResumeTurnStore(work, FERRET)).toThrow('internal sessions root only (got work)');
  });

  test('a turn number below one names no document', async () => {
    const { store } = await subject();
    expect(() => store.file(FERRET, 0)).toThrow('from one');
  });
});
