import { afterEach, describe, it } from 'bun:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileSessionAttachmentStore } from '../../../src/adapters/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The files an opening message attached, on a real disk.
 *
 * The store only WRITES: what each file is and where it goes was decided in memory by
 * `planInitialAttachments`, which is what lets a start compose the opening message before the
 * session record exists and put the bytes down after it does.
 */

/** Deterministic temporary suffixes, so an atomic write is provable rather than incidental. */
function store(): FileSessionAttachmentStore {
  let counter = 0;
  return new FileSessionAttachmentStore(() => {
    counter += 1;
    return `t${counter}`;
  });
}

afterEach(async () => {
  await cleanupTempDirectories();
});

describe('FileSessionAttachmentStore', () => {
  it('should create the attachment directory and write every planned file', async () => {
    // Arrange — the directory does not exist yet: a start writes into a session directory storage has
    // just claimed, and `attachments/` inside it is this store's to make.
    const home = await tempDirectory('fyd-attachment-store');
    const directory = join(home, 'sessions', 's1', 'attachments');
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    // Act
    await store().write([
      { file: join(directory, 'brief.docx'), contents: bytes },
      { file: join(directory, 'brief.docx.txt'), contents: 'the brief, as words' },
    ]);

    // Assert
    should(new Uint8Array(await readFile(join(directory, 'brief.docx')))).deepEqual(bytes);
    should(await readFile(join(directory, 'brief.docx.txt'), 'utf8')).equal('the brief, as words');
    // Private to the daemon's own user, like every other document in the state home.
    should((await stat(join(directory, 'brief.docx'))).mode & 0o777).equal(0o600);
    should((await stat(directory)).mode & 0o777).equal(0o700);
    // Nothing temporary survived: the agent never sees a half-written attachment.
    should((await readdir(directory)).sort()).deepEqual(['brief.docx', 'brief.docx.txt']);
  });

  it('should write nothing at all when the opening message attached nothing', async () => {
    // Arrange
    const home = await tempDirectory('fyd-attachment-store');

    // Act
    await store().write([]);

    // Assert — no directory was created for a start that attached no files.
    should(await readdir(home)).be.empty();
  });

  it('should refuse a write it cannot perform rather than reporting a file it never made', async () => {
    // Arrange — a path whose parent is a FILE: `mkdir` cannot make the directory, so the start must
    // learn the attachment is not there.
    const home = await tempDirectory('fyd-attachment-store');
    const blocker = join(home, 'blocker');
    await Bun.write(blocker, 'not a directory');

    // Act + Assert
    await should(store().write([{ file: join(blocker, 'brief.docx'), contents: 'x' }])).be.rejected();
  });
});
