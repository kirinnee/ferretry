import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import should from 'should';
import { LOGINS_MODEL_LISTS, type ModelListView } from '../../../contract/model-list.ts';
import { StateModelListStore } from '../../../daemon/adapters/models/state-model-list-store.ts';

const LIST: ModelListView = {
  fetchedAt: '2026-11-23T00:00:00.000Z' as Instant,
  complete: true,
  ids: ['deepseek-chat', 'deepseek-reasoner'],
};

const world = () => {
  const folder = new MemoryStateFolder();
  return { folder, store: new StateModelListStore(folder.port([LOGINS_MODEL_LISTS])) };
};

describe('the model lists, held in state/logins/model-lists/<login>.json', () => {
  it('should keep one file per login, ids and instant only, and read it back', async () => {
    // Arrange
    const { folder, store } = world();

    // Act
    await store.write('deepseek', LIST);

    // Assert
    should(await store.read('deepseek')).eql(LIST);
    should(JSON.parse(folder.raw(LOGINS_MODEL_LISTS, 'deepseek') as string)).eql({ format: 1, ...LIST });
    should(await store.read('another')).be.undefined();
    should(await store.logins()).eql(['deepseek']);
  });

  it('should read a damaged or foreign file as none held', async () => {
    // Arrange
    const { folder, store } = world();
    folder.plant(LOGINS_MODEL_LISTS, '{ not json', 'broken');
    folder.plant(
      LOGINS_MODEL_LISTS,
      JSON.stringify({ format: 1, fetchedAt: LIST.fetchedAt, complete: true, ids: ['has a space'] }),
      'odd',
    );

    // Assert
    should(await store.read('broken')).be.undefined();
    should(await store.read('odd')).be.undefined();
  });

  it('should remove a list with its login, and ignore a name that is not a login id', async () => {
    // Arrange
    const { folder, store } = world();
    await store.write('deepseek', LIST);

    // Act
    await store.remove('deepseek');
    await store.write('../escape', LIST);
    await store.remove('../escape');

    // Assert
    should(await store.read('deepseek')).be.undefined();
    should(folder.files.size).equal(0);
    should(await store.read('../escape')).be.undefined();
  });
});
