import { describe, it } from 'bun:test';
import should from 'should';
import { FileSystemAgendaDirectoryListing } from '../../../src/adapters/agenda/pre-rename-agenda-listing.ts';
import {
  type AgendaDirectoryEntries,
  PreRenameAgendaFilesError,
  refusePreRenameAgendaFiles,
} from '../../../src/lib/agenda/index.ts';

const listing = (...directories: readonly AgendaDirectoryEntries[]) => ({ list: async () => directories });

describe('refusePreRenameAgendaFiles', () => {
  it('refuses a session that holds only the old-named files', async () => {
    const error = await refusePreRenameAgendaFiles(
      listing({ path: '/s/one', names: ['attention.json', 'attention-replies.json', 'session.json'] }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    should(error).be.instanceOf(PreRenameAgendaFilesError);
    should((error as PreRenameAgendaFilesError).found).deepEqual([
      '/s/one/attention.json',
      '/s/one/attention-replies.json',
    ]);
    should((error as Error).message).containEql('/s/one/attention.json');
    should((error as Error).message).containEql('(2 in all)');
    should((error as Error).message).containEql('Back these directories up first');
    should((error as Error).message).containEql('rename attention.json → agenda.json');
    should((error as Error).message).containEql('only where the new name does not exist yet');
    should((error as Error).message).containEql('then rename the old file to <name>.migrated');
    should((error as Error).message).containEql(
      'Every Ferretry release from 4.116.0 up to, but excluding, the release that removed this move',
    );
    should((error as Error).message).not.containEql('4.291.0');
    should((error as Error).message).not.containEql('Start Ferretry');
  });

  it('refuses when the old and the current names are both present', async () => {
    await should(
      refusePreRenameAgendaFiles(listing({ path: '/s/one', names: ['agenda.json', 'attention.json'] })),
    ).be.rejectedWith(PreRenameAgendaFilesError);
  });

  it('refuses the machine agenda directory too, and names only the first few paths', async () => {
    const sessions = Array.from({ length: 7 }, (_, index) => ({
      path: `/s/${String(index)}`,
      names: ['attention.json'],
    }));
    const error = await refusePreRenameAgendaFiles(
      listing(...sessions, { path: '/state/machine-agenda', names: ['attention.json'] }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    should((error as PreRenameAgendaFilesError).found).have.length(8);
    should((error as Error).message).containEql('(8 in all)');
    should((error as Error).message).containEql('/s/4/attention.json');
    should((error as Error).message).not.containEql('/s/5/attention.json');
  });

  it('passes on the current names, on *.migrated backups, and on nothing', async () => {
    await refusePreRenameAgendaFiles(
      listing(
        { path: '/s/one', names: ['agenda.json', 'agenda-replies.json', 'session.json'] },
        { path: '/s/two', names: ['attention.json.migrated', 'attention-replies.json.migrated', 'agenda.json'] },
        { path: '/s/three', names: [] },
      ),
    );
    await refusePreRenameAgendaFiles(listing());
  });
});

describe('FileSystemAgendaDirectoryListing', () => {
  it('reads every session directory — indexed or not — and the machine directory, once each', async () => {
    const reads: string[] = [];
    const tree: Record<string, readonly { name: string; directory: boolean }[]> = {
      '/state/sessions': [
        { name: 'one', directory: true },
        { name: 'stray-file', directory: false },
        { name: 'dropped-from-index', directory: true },
      ],
      '/state/sessions/one': [{ name: 'attention.json', directory: false }],
      '/state/sessions/dropped-from-index': [{ name: 'agenda.json', directory: false }],
      '/state/machine-agenda': [{ name: 'attention-replies.json', directory: false }],
    };
    const files = {
      listDirectory: async (path: string) => {
        reads.push(path);
        return tree[path] ?? [];
      },
    };
    const found = await new FileSystemAgendaDirectoryListing(files, '/state/sessions', '/state').list();
    should(found).deepEqual([
      { path: '/state/sessions/one', names: ['attention.json'] },
      { path: '/state/sessions/dropped-from-index', names: ['agenda.json'] },
      { path: '/state/machine-agenda', names: ['attention-replies.json'] },
    ]);
    should(reads).have.length(4);
  });
});
