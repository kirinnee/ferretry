import { describe, expect, it } from 'bun:test';
import {
  folderBaseName,
  folderOptions,
  folderSource,
  LOADING_FOLDERS,
  normalizeFolder,
  readRecentFolders,
  recentFolders,
} from '../../../../app/features/new-ferret/recent-folders.ts';
import { scripted } from '../support/client.ts';
import { recent, summaryAt } from './page-support.tsx';

describe('recentFolders', () => {
  it('orders folders newest first and offers each once, at its newest instant', () => {
    expect(
      recentFolders([
        summaryAt('/work/a', '2026-01-01T00:00:00Z'),
        summaryAt('/work/b', '2026-03-01T00:00:00Z'),
        summaryAt('/work/a', '2026-02-01T00:00:00Z'),
      ]),
    ).toEqual([recent('/work/b', '2026-03-01T00:00:00Z'), recent('/work/a', '2026-02-01T00:00:00Z')]);
  });

  it('breaks a tie by path, and treats a trailing slash as the same folder', () => {
    expect(
      recentFolders([summaryAt('/work/z/', '2026-01-01T00:00:00Z'), summaryAt('/work/a', '2026-01-01T00:00:00Z')]).map(
        folder => folder.path,
      ),
    ).toEqual(['/work/a', '/work/z']);
    expect(normalizeFolder('/work/a///')).toBe('/work/a');
    expect(normalizeFolder('/')).toBe('/');
  });

  it('skips a record that is not a ferret summary rather than failing the list', () => {
    expect(
      recentFolders([null, 4, { folder: '' }, { folder: '/ok' }, summaryAt('/work/a', '2026-01-01T00:00:00Z')]),
    ).toEqual([recent('/work/a', '2026-01-01T00:00:00Z')]);
  });
});

describe('folderOptions', () => {
  it('names a folder by its last segment, commits the full path, and searches both and its provenance', () => {
    const [option] = folderOptions([recent('/home/you/my-project', '2026-01-01T00:00:00Z')]);
    expect(option).toMatchObject({
      value: '/home/you/my-project',
      label: 'my-project',
      detail: '/home/you/my-project',
    });
    expect(option?.search).toBe('my-project /home/you/my-project recent');
    expect(folderBaseName('/')).toBe('/');
  });
});

describe('folderSource', () => {
  it('claims nothing while the list is still being read', () => {
    expect(folderSource(LOADING_FOLDERS)).toEqual({ kind: 'loading' });
  });

  it('says a read that never succeeded failed, in the daemon’s words when it gave any', () => {
    expect(folderSource({ status: 'error', folders: null, error: 'boom' })).toEqual({ kind: 'failed', reason: 'boom' });
    expect(folderSource({ status: 'error', folders: null, error: null })).toMatchObject({ kind: 'failed' });
  });

  it('offers a positively empty list as empty, not as unread', () => {
    expect(folderSource({ status: 'ready', folders: [], error: null })).toEqual({ kind: 'ready', options: [] });
  });

  it('keeps the rows and says they may be out of date when a later refresh fails', () => {
    const source = folderSource({ status: 'error', folders: [recent('/work/a', '2026-01-01T00:00:00Z')], error: null });
    expect(source).toMatchObject({ kind: 'ready' });
    expect(source.kind === 'ready' ? source.staleReason : undefined).toContain('out of date');
    expect(source.kind === 'ready' ? source.options : []).toHaveLength(1);
  });
});

describe('readRecentFolders', () => {
  it('reads the ferret list once by route key', async () => {
    const calls: unknown[] = [];
    const client = scripted({ 'GET /v1/ferrets': [summaryAt('/work/a', '2026-01-01T00:00:00Z')] }, calls as never[]);
    expect(await readRecentFolders(client)).toEqual([recent('/work/a', '2026-01-01T00:00:00Z')]);
    expect(calls).toHaveLength(1);
  });

  it('refuses an answer that is not a list', async () => {
    await expect(readRecentFolders(scripted({ 'GET /v1/ferrets': { nope: true } }))).rejects.toThrow('cannot read');
  });
});
