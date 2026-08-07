import { afterEach, describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { FileSessionAttachmentCopier } from '../../../src/adapters/transfer/attachment-copier.ts';
import { SessionAttachmentStore } from '../../../src/lib/attachments/session-attachments.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The composition fact this file exists to pin: A FORK'S COPIER AND THE DAEMON'S ATTACHMENT STORE
 * MUST ADDRESS ONE TREE.
 *
 * `SessionAttachmentStore` composes `<state>/attachments/<daemonId>/<sessionId>` internally, and
 * `FileSessionAttachmentCopier` is handed a directory resolver by the composition root. Those are
 * two independent statements of one layout, and nothing in either type forces them to agree — which
 * is exactly how the first draft of `createForkSubsystem` pointed the copier at
 * `<session directory>/attachments` instead.
 *
 * A UNIT TEST WITH A FAKE RESOLVER CANNOT SEE IT, because the disagreement is between two real
 * implementations of one layout and a fake agrees with whichever one the test wrote. So the proof
 * has to run the real store against the real copier on a real filesystem, which is what this does,
 * and it asserts through the store's own PUBLIC surface rather than by comparing path strings: a
 * test that recomputed the layout would be a THIRD statement of it, and would pass happily while
 * both of the other two were wrong together.
 *
 * WHAT THE WRONG TREE ACTUALLY DOES, since the third case below settles it and the guess was worth
 * correcting: the copier reads the source and writes the target through the SAME resolver, so a
 * wrong one cannot find the source either and refuses. The shipped failure would therefore have been
 * "every fork carrying an attachment refuses", not "the target lists files it cannot open" — louder
 * than feared, and still a fork nobody could use.
 */

const DAEMON_ID = 'daemon-a';
const SOURCE = 'source-a';
const TARGET = 'target-b';
const BYTES = new TextEncoder().encode('the quick brown fox');

afterEach(async () => {
  await cleanupTempDirectories();
});

describe('the fork attachment tree', () => {
  it('should copy an original the singleton attachment store can then read from the target', async () => {
    const state = await tempDirectory('fork-attachments');
    const store = new SessionAttachmentStore({ root: state, daemonId: DAEMON_ID });
    const uploaded = await store.upload(SOURCE, { filename: 'notes.txt', mime: 'text/plain', bytes: BYTES });

    // The exact resolver `createForkSubsystem` is handed in `bin/fyd.ts`, spelled once here so this
    // test fails if that wiring is changed to a different tree.
    const copier = new FileSessionAttachmentCopier(id => join(state, 'attachments', DAEMON_ID, id));
    await copier.copyOriginal({
      fromSessionId: SOURCE,
      newSessionId: TARGET,
      expectedManifest: { ...uploaded, encrypted: null },
    });

    // THE ASSERTION THAT MATTERS: the store — the one every route reads through — finds it.
    const downloaded = await store.download(TARGET, uploaded.id);
    should(downloaded.bytes).eql(BYTES);
    should(downloaded.attachment.id).equal(uploaded.id);
    should(downloaded.attachment.filename).equal('notes.txt');

    // And it is listed, so the target's own inventory agrees with what can be opened.
    should((await store.list(TARGET)).map(view => view.id)).eql([uploaded.id]);
  });

  it('should leave the source readable and unchanged, because a fork never touches what it read', async () => {
    const state = await tempDirectory('fork-attachments');
    const store = new SessionAttachmentStore({ root: state, daemonId: DAEMON_ID });
    const uploaded = await store.upload(SOURCE, { filename: 'notes.txt', mime: 'text/plain', bytes: BYTES });

    const copier = new FileSessionAttachmentCopier(id => join(state, 'attachments', DAEMON_ID, id));
    await copier.copyOriginal({
      fromSessionId: SOURCE,
      newSessionId: TARGET,
      expectedManifest: { ...uploaded, encrypted: null },
    });

    should((await store.download(SOURCE, uploaded.id)).bytes).eql(BYTES);
    should((await store.list(SOURCE)).map(view => view.id)).eql([uploaded.id]);
  });

  /**
   * The negative half — and it turned out kinder than expected, which is worth recording.
   *
   * The copier reads the source and writes the target through ONE resolver, so a resolver pointed at
   * the wrong tree cannot find the source either and refuses loudly instead of writing bytes
   * somewhere `download` will never look. The first draft of `createForkSubsystem` passed
   * `<session directory>/attachments`, so the failure mode it would really have produced is "every
   * fork carrying an attachment refuses" rather than "the target lists files it cannot open".
   *
   * The refusal is the guard, so this pins it: a wrong tree is caught before anything is written to
   * the target, and the target stays empty.
   */
  it('should refuse and write nothing when the copier is pointed at another tree', async () => {
    const state = await tempDirectory('fork-attachments');
    const store = new SessionAttachmentStore({ root: state, daemonId: DAEMON_ID });
    const uploaded = await store.upload(SOURCE, { filename: 'notes.txt', mime: 'text/plain', bytes: BYTES });

    const wrong = new FileSessionAttachmentCopier(id => join(state, 'sessions', id, 'attachments'));

    await wrong
      .copyOriginal({
        fromSessionId: SOURCE,
        newSessionId: TARGET,
        expectedManifest: { ...uploaded, encrypted: null },
      })
      .then(
        () => {
          throw new Error('a copier pointed outside the store tree must not report success');
        },
        (error: unknown) => should(String(error)).match(/not found/u),
      );

    should(await store.list(TARGET)).eql([]);
    // And the source is still whole: a refused copy touches nothing on either side.
    should((await store.download(SOURCE, uploaded.id)).bytes).eql(BYTES);
  });
});
