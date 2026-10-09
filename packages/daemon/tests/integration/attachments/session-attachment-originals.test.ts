import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileAttachmentOriginals } from '../../../src/adapters/attachments/index.ts';
import { attachmentDirectory, SessionAttachmentStore } from '../../../src/lib/attachments/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * A session's attachment originals on a real disk, in the tree `attachmentDirectory` names.
 *
 * The store's policy is proved in the unit tier over an in-memory fake; what only a filesystem can
 * show is here — the layout, the modes, that a torn or failed upload leaves no manifest, and that
 * an unlock never writes plaintext beside the original.
 */

const ID = `att_${'a'.repeat(64)}`;
const encryptedPdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>\n');
const plaintext = new TextEncoder().encode('%PDF-1.7\nsecret plaintext must stay in RAM\n');

afterEach(async () => {
  await cleanupTempDirectories();
});

function originals(root: string): FileAttachmentOriginals {
  return new FileAttachmentOriginals(id => attachmentDirectory(root, 'daemon-a', id));
}

describe('FileAttachmentOriginals', () => {
  it('publishes exactly an original and a manifest, private to the daemon user', async () => {
    const root = await tempDirectory('attachment-originals');
    await originals(root).publish('session-a', ID, new Uint8Array([1, 2]), '{"m":1}\n');

    const directory = join(root, 'attachments', 'daemon-a', 'session-a', ID);
    should((await readdir(directory)).sort()).deepEqual(['manifest.json', 'original']);
    should((await stat(directory)).mode & 0o777).equal(0o700);
    should((await stat(join(directory, 'original'))).mode & 0o777).equal(0o600);
    should((await stat(join(directory, 'manifest.json'))).mode & 0o777).equal(0o600);
    should(await originals(root).readManifest('session-a', ID)).equal('{"m":1}\n');
    should([...(await originals(root).readOriginal('session-a', ID))]).deepEqual([1, 2]);
  });

  it('lists only directories, and an absent session as empty', async () => {
    const root = await tempDirectory('attachment-originals');
    const files = originals(root);
    should(await files.attachmentIds('session-a')).deepEqual([]);

    await files.publish('session-a', ID, new Uint8Array([1]), '{}');
    await writeFile(join(attachmentDirectory(root, 'daemon-a', 'session-a'), `att_${'b'.repeat(64)}`), 'a stray file');

    should(await files.attachmentIds('session-a')).deepEqual([ID]);
    should(await files.readManifest('session-a', `att_${'c'.repeat(64)}`)).be.undefined();
  });

  it('removes a half-written attachment so no manifest vouches for missing bytes', async () => {
    const root = await tempDirectory('attachment-originals');
    const directory = join(attachmentDirectory(root, 'daemon-a', 'session-a'), ID);
    // A temporary name that already exists makes the exclusive manifest write fail after the original.
    const files = new FileAttachmentOriginals(
      id => attachmentDirectory(root, 'daemon-a', id),
      () => 'fixed',
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.manifest-fixed.tmp'), 'occupied');

    await files.publish('session-a', ID, new Uint8Array([1]), '{}').then(
      () => {
        throw new Error('a failed manifest write must surface');
      },
      error => should(error).have.property('code', 'EEXIST'),
    );
    await stat(directory).then(
      () => {
        throw new Error('the half-written attachment must be removed');
      },
      error => should(error).have.property('code', 'ENOENT'),
    );
  });

  it('raises a read failure that is not an absence', async () => {
    const root = await tempDirectory('attachment-originals');
    const sessionTree = attachmentDirectory(root, 'daemon-a', 'session-a');
    await mkdir(join(sessionTree, ID, 'manifest.json'), { recursive: true });
    await writeFile(join(root, 'attachments', 'daemon-a', 'session-b'), 'not a directory');

    await originals(root)
      .readManifest('session-a', ID)
      .then(
        () => {
          throw new Error('a manifest that is a directory must not read as absent');
        },
        error => should(error).have.property('code', 'EISDIR'),
      );
    await originals(root)
      .attachmentIds('session-b')
      .then(
        () => {
          throw new Error('a session tree that is a file must not read as empty');
        },
        error => should(error).have.property('code', 'ENOTDIR'),
      );
  });

  it('never writes an unlocked plaintext beside the encrypted original', async () => {
    const root = await tempDirectory('attachment-originals');
    const store = new SessionAttachmentStore({
      daemonId: 'daemon-a',
      originals: originals(root),
      decrypt: async () => plaintext.slice(),
    });
    const uploaded = await store.upload('session-a', {
      filename: 'private.pdf',
      mime: 'application/pdf',
      bytes: encryptedPdf,
    });
    should((await store.unlock('session-a', uploaded.id, 'pw')).encrypted?.locked).be.false();

    const directory = join(attachmentDirectory(root, 'daemon-a', 'session-a'), uploaded.id);
    should((await readdir(directory)).sort()).deepEqual(['manifest.json', 'original']);
    should(await readFile(join(directory, 'original'), 'utf8')).equal(new TextDecoder().decode(encryptedPdf));
  });
});
