import { describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileBoardSwitchStore } from '../../../src/adapters/board-projects/file-board-switch-store.ts';
import {
  BOARD_SWITCH_UNAVAILABLE_MESSAGE,
  BoardSwitchUnavailableError,
} from '../../../src/lib/board-projects/errors.ts';
import type { BoardSwitchDocument } from '../../../src/lib/board-projects/index.ts';
import { withTempRoot } from '../atomic-file/fixtures.ts';

const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10';
const AT = '2026-11-01T12:00:00.000Z';

const document = (on: boolean): BoardSwitchDocument => ({
  v: 1,
  migratedAt: AT,
  boards: { [PROJECT]: { on, setBy: 'owner', setAt: AT } },
});

describe('the board switch store', () => {
  it('should read nothing before the first write', async () => {
    await withTempRoot(async root => {
      should(await new FileBoardSwitchStore(join(root, 'board', 'switch.json')).read()).equal(null);
    });
  });

  it('should write a decided document atomically, read it back, and keep it when nothing is decided', async () => {
    await withTempRoot(async root => {
      const store = new FileBoardSwitchStore(join(root, 'board', 'switch.json'));
      should(await store.transact(() => ({ next: document(true), result: 'ok' }))).equal('ok');
      should(await store.transact(current => ({ result: current?.boards[PROJECT]?.on }))).equal(true);
      should(await store.read()).eql(document(true));
      should(JSON.parse(await readFile(join(root, 'board', 'switch.json'), 'utf8'))).eql(document(true));
    });
  });

  it('should refuse a damaged document, never overwrite it, and keep its path out of the message', async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'board'), { recursive: true });
      const path = join(root, 'board', 'switch.json');
      for (const text of ['{not json', JSON.stringify({ v: 2 })]) {
        await writeFile(path, text);
        const store = new FileBoardSwitchStore(path);
        const refused = await store.read().then(
          () => null,
          (error: unknown) => error,
        );
        should(refused).be.instanceOf(BoardSwitchUnavailableError);
        should((refused as BoardSwitchUnavailableError).message).equal(BOARD_SWITCH_UNAVAILABLE_MESSAGE);
        should((refused as BoardSwitchUnavailableError).detail).containEql(path);
        await store.transact(() => ({ next: document(false), result: undefined })).catch(() => undefined);
        should(await readFile(path, 'utf8')).equal(text);
      }
    });
  });
});
