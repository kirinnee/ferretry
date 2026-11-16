import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import { fenced, ferretId } from '../../../../../contract/testing/index.ts';
import { LaunchStepRegistry, paneVariables } from '../../../../../daemon/lib/ferrets/launch-steps.ts';
import {
  MEDIA_FOLDER_VARIABLE,
  paneFileStores,
  type PaneFileFolders,
  QUESTION_FILE_VARIABLE,
} from '../../../../../daemon/lib/ferrets/session-stores/pane-files.ts';

/** The question file and the media folder: two stores over a ferret's own session folder. Fixture paths only. */

const folders = (log: string[], unresolvable?: string): PaneFileFolders => ({
  root: ferret => ({
    resolve: name => (name === unresolvable ? err('outside') : ok(fenced(`/sessions/${ferret}/${name}`))),
  }),
  ensureMediaFolder: async ferret => {
    log.push(`ensure ${ferret}`);
  },
});

describe('the pane file stores', () => {
  test('are the question file then the media folder, each on its own FY_* variable', () => {
    const stores = paneFileStores(folders([]));
    expect(stores.map(held => [held.id, held.variable])).toEqual([
      ['question-file', 'FY_QUESTION_FILE'],
      ['media-folder', 'FY_MEDIA_DIR'],
    ]);
    expect(QUESTION_FILE_VARIABLE).toBe('FY_QUESTION_FILE');
    expect(MEDIA_FOLDER_VARIABLE).toBe('FY_MEDIA_DIR');
    // Both register on a real registry: distinct, FY_*, none reserved.
    const registry = new LaunchStepRegistry();
    for (const held of stores) registry.paneVariable(held);
    expect(registry.stores()).toHaveLength(2);
  });

  test('hand the pane the question file and the media folder, making only the media folder', async () => {
    const log: string[] = [];
    const variables = await paneVariables(paneFileStores(folders(log)), ferretId('f1'));
    expect(variables).toEqual({
      FY_QUESTION_FILE: '/sessions/f1/question-asked.json',
      FY_MEDIA_DIR: '/sessions/f1/media',
    });
    expect(log).toEqual(['ensure f1']);
  });

  test('a name that cannot be resolved sets that variable only, and a media folder is not made for it', async () => {
    const log: string[] = [];
    const variables = await paneVariables(paneFileStores(folders(log, 'media')), ferretId('f1'));
    expect(variables).toEqual({ FY_QUESTION_FILE: '/sessions/f1/question-asked.json' });
    expect(log).toEqual([]);
  });

  test('a media folder that cannot be made sets no variable and never stops the question file', async () => {
    const failing: PaneFileFolders = {
      ...folders([]),
      ensureMediaFolder: async () => {
        throw new Error('FIXTURE_SECRET disk full');
      },
    };
    const [, media] = paneFileStores(failing);
    expect(await media?.locate(ferretId('f1')).catch((error: Error) => error.message)).toBe('FIXTURE_SECRET disk full');
    const variables = await paneVariables(paneFileStores(failing), ferretId('f1'));
    expect(variables).toEqual({ FY_QUESTION_FILE: '/sessions/f1/question-asked.json' });
  });
});
