import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AttachmentFacet } from '../../../../contract/transfer.ts';
import should from 'should';
import {
  FileSessionAttachmentCopier,
  SessionAttachmentCopyError,
} from '../../../../daemon/adapters/transfer/attachment-copier.ts';
import { MemoryAttachmentStore } from './memory-attachment-store.ts';

/**
 * Daemon-local attachment copying through the attachment owner's store. Every call names the explicit NEW session,
 * copies verified original bytes and the manifest under the same content address, carries locked state, copies NO
 * decrypted plaintext, and leaves the source byte-for-byte untouched.
 *
 * The store is a fake (the port is unbound; its real implementation is Conversation's). It records each call so the
 * tests can pin what the copier asked of it, in what order, and for which session.
 */

const SOURCE = 'source-session';
const TARGET = 'target-session';

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Minted {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly manifest: Record<string, unknown>;
  readonly expectedManifest: AttachmentFacet['attachments'][number];
}

/** Puts a source attachment into the store in the owner's layout, and returns it. */
function mintAttachment(
  store: MemoryAttachmentStore,
  sessionId: string,
  bytes: Uint8Array,
  options: { encrypted?: boolean; filename?: string } = {},
): Minted {
  const id = `att_${sha(bytes)}`;
  const manifest = {
    id,
    filename: options.filename ?? 'report.pdf',
    mime: 'application/pdf',
    size: bytes.byteLength,
    sha256: sha(bytes),
    createdAt: '2025-01-01T00:00:00+00:00',
    ...(options.encrypted ? { encrypted: { kind: 'pdf' } } : {}),
  };
  store.put(sessionId, id, 'original', bytes);
  store.put(sessionId, id, 'manifest', JSON.stringify(manifest));
  return {
    id,
    bytes,
    manifest,
    expectedManifest: {
      id,
      filename: manifest.filename,
      mime: manifest.mime,
      size: manifest.size,
      sha256: manifest.sha256,
      createdAt: manifest.createdAt,
      encrypted: options.encrypted ? { kind: 'pdf', locked: true } : null,
    } as AttachmentFacet['attachments'][number],
  };
}

function planned(minted: Minted, newSessionId: string = TARGET) {
  return {
    fromSessionId: SOURCE,
    newSessionId,
    expectedManifest: minted.expectedManifest,
  };
}

/** Resolves to the rejection reason, failing loudly if the call unexpectedly resolved. */
async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function setup(): { readonly store: MemoryAttachmentStore; readonly subject: FileSessionAttachmentCopier } {
  const store = new MemoryAttachmentStore();
  return { store, subject: new FileSessionAttachmentCopier(store) };
}

/** Rewrites the source manifest with extra or changed fields. */
function reMint(store: MemoryAttachmentStore, minted: Minted, changes: Record<string, unknown>): void {
  store.put(SOURCE, minted.id, 'manifest', JSON.stringify({ ...minted.manifest, ...changes }));
}

describe('FileSessionAttachmentCopier', () => {
  it('preserves the content address and original bytes, carrying locked state and no decrypted cache', async () => {
    // An encrypted attachment is copied as-is into the explicit target: same att_<sha> id, same original
    // bytes (still encrypted — never decrypted), manifest carrying encrypted:{kind:'pdf'}. The target
    // begins LOCKED because the decrypted-plaintext cache is process-local and session-keyed, so
    // nothing of it is (or could be) copied.
    // Arrange
    const { store, subject } = setup();
    const encrypted = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x99, 0xaa, 0xff]); // not valid plaintext
    const minted = mintAttachment(store, SOURCE, encrypted, { encrypted: true });

    // Act
    await subject.copyOriginal(planned(minted));

    // Assert — id and bytes preserved verbatim.
    should(store.bytes(TARGET, minted.id, 'original')).deepEqual(encrypted);
    // Locked state + metadata carried: the manifest still names an encrypted pdf, and ONLY original +
    // manifest exist under the target (no decrypted plaintext file was written).
    const manifest = JSON.parse(store.text(TARGET, minted.id, 'manifest') ?? 'null') as { encrypted: unknown };
    should(manifest.encrypted).deepEqual({ kind: 'pdf' });
    should([...store.files.keys()].filter(file => file.startsWith(`${TARGET}/`)).sort()).deepEqual([
      `${TARGET}/${minted.id}/manifest`,
      `${TARGET}/${minted.id}/original`,
    ]);
  });

  it('copies the manifest verbatim, byte for byte', async () => {
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([1, 2, 3]), { encrypted: true });

    // Act
    await subject.copyOriginal(planned(minted));

    // Assert
    should(store.bytes(TARGET, minted.id, 'manifest')).deepEqual(store.bytes(SOURCE, minted.id, 'manifest'));
  });

  it('leaves the source byte-for-byte untouched', async () => {
    // Source immutability is seam invariant I1. The copier only ever READS the source: it never writes to the
    // source session's key, so its original and manifest are identical after a copy.
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const beforeOriginal = new Uint8Array(store.bytes(SOURCE, minted.id, 'original') ?? []);
    const beforeManifest = store.text(SOURCE, minted.id, 'manifest');

    // Act
    await subject.copyOriginal(planned(minted));

    // Assert — source content unchanged and no write ever named the source session.
    should(store.bytes(SOURCE, minted.id, 'original')).deepEqual(beforeOriginal);
    should(store.text(SOURCE, minted.id, 'manifest')).equal(beforeManifest);
    should(store.writesOf(SOURCE)).deepEqual([]);
  });

  it('is idempotent from the plan: a verified target survives later source mutation untouched', async () => {
    // A restart re-runs import, so a target that already holds the same bytes is accepted.
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([10, 20, 30]));

    // Act
    await subject.copyOriginal(planned(minted));
    // A previously copied target is independently proved against the plan. Replay does not become
    // impossible merely because the source changed after a later attachment failed.
    store.put(SOURCE, minted.id, 'original', new Uint8Array([99, 98, 97, 96]));
    await subject.copyOriginal(planned(minted));

    // Assert — second call did not throw and the target still holds the planned bytes.
    should(store.bytes(TARGET, minted.id, 'original')).deepEqual(minted.bytes);
  });

  it('repairs a torn target from source bytes that still match the plan', async () => {
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([8, 7, 6, 5]));
    await subject.copyOriginal(planned(minted));
    store.put(TARGET, minted.id, 'original', new Uint8Array([0]));

    // Act
    await subject.copyOriginal(planned(minted));

    // Assert
    should(store.bytes(TARGET, minted.id, 'original')).deepEqual(minted.bytes);
  });

  it('copies several attachments under their respective content addresses', async () => {
    // Arrange
    const { store, subject } = setup();
    const one = mintAttachment(store, SOURCE, new Uint8Array([1, 1, 1]));
    const two = mintAttachment(store, SOURCE, new Uint8Array([2, 2, 2]));

    // Act
    await subject.copyOriginal(planned(one));
    await subject.copyOriginal(planned(two));

    // Assert
    should(store.bytes(TARGET, one.id, 'original')).deepEqual(one.bytes);
    should(store.bytes(TARGET, two.id, 'original')).deepEqual(two.bytes);
  });

  it('refuses a missing source attachment with a not_found failure', async () => {
    // Arrange
    const { subject } = setup();
    const phantom = 'att_0000000000000000000000000000000000000000000000000000000000000000';

    // Act + Assert
    const error = await reject(
      subject.copyOriginal({
        fromSessionId: SOURCE,
        newSessionId: TARGET,
        expectedManifest: {
          id: phantom,
          filename: 'missing.bin',
          mime: 'application/octet-stream',
          size: 1,
          sha256: '0'.repeat(64),
          createdAt: '2025-01-01T00:00:00+00:00',
          encrypted: null,
        },
      }),
    );
    should(error).be.instanceOf(SessionAttachmentCopyError);
    should((error as SessionAttachmentCopyError).failure).equal('not_found');
  });

  it('refuses a source whose original no longer matches its manifest with a corrupt failure', async () => {
    // Arrange — the manifest names one sha, the original holds different bytes.
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([1, 2, 3]));
    store.put(SOURCE, minted.id, 'original', new Uint8Array([9, 9, 9]));

    // Act + Assert
    const error = await reject(subject.copyOriginal(planned(minted)));
    should((error as SessionAttachmentCopyError).failure).equal('corrupt');
    should(store.writesOf(TARGET)).deepEqual([]);
  });

  it('refuses a source coherently rewritten after planning even when its new bytes match its new manifest', async () => {
    // Arrange — this is the adversarial gap a manifest-only check misses: both source files agree,
    // but they no longer agree with the content identity frozen in the persisted transfer plan.
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([1, 2, 3, 4]));
    const input = planned(minted);
    const replacement = new Uint8Array([9, 8, 7, 6]);
    store.put(SOURCE, minted.id, 'original', replacement);
    reMint(store, minted, { size: replacement.byteLength, sha256: sha(replacement), id: `att_${sha(replacement)}` });
    // The owner's parser reads the manifest under the planned id; the rewritten one names another, so it is invalid.
    const error = await reject(subject.copyOriginal(input));
    should((error as SessionAttachmentCopyError).failure).equal('corrupt');
    should(store.writesOf(TARGET)).deepEqual([]);
  });

  it('refuses every planned manifest field drifting over unchanged bytes, including locked state', async () => {
    const mutations: readonly Readonly<Record<string, unknown>>[] = [
      { filename: 'renamed.pdf' },
      { mime: 'application/octet-stream' },
      { createdAt: '2025-01-02T00:00:00+00:00' },
      { encrypted: { kind: 'pdf' } },
    ];

    for (const [index, mutation] of mutations.entries()) {
      const { store, subject } = setup();
      const minted = mintAttachment(store, SOURCE, new Uint8Array([1, 2, 3, index]));
      reMint(store, minted, mutation);

      const error = await reject(subject.copyOriginal(planned(minted)));
      should((error as SessionAttachmentCopyError).failure).equal('corrupt');
      should((error as Error).message).containEql('does not match the transfer plan');
      should(store.writesOf(TARGET)).deepEqual([]);
    }
  });

  it('refuses an unplanned source manifest field instead of copying its raw bytes into the target', async () => {
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([4, 4, 4]));
    reMint(store, minted, { sourceOnlySecret: 'must-not-cross' });

    const error = await reject(subject.copyOriginal(planned(minted)));

    should((error as SessionAttachmentCopyError).failure).equal('corrupt');
    should((error as Error).message).containEql('manifest is invalid');
    should(store.writesOf(TARGET)).deepEqual([]);
  });

  it('repairs target manifest metadata drift only from a source that still matches the plan', async () => {
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([7, 7, 7]));
    await subject.copyOriginal(planned(minted));
    const target = JSON.parse(store.text(TARGET, minted.id, 'manifest') ?? 'null') as Record<string, unknown>;
    store.put(TARGET, minted.id, 'manifest', JSON.stringify({ ...target, filename: 'drifted.txt' }));

    await subject.copyOriginal(planned(minted));

    should(store.bytes(TARGET, minted.id, 'manifest')).deepEqual(store.bytes(SOURCE, minted.id, 'manifest'));
  });

  it('removes an unplanned target manifest field only after re-proving the source against the plan', async () => {
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([6, 6, 6]));
    await subject.copyOriginal(planned(minted));
    const target = JSON.parse(store.text(TARGET, minted.id, 'manifest') ?? 'null') as Record<string, unknown>;
    store.put(TARGET, minted.id, 'manifest', JSON.stringify({ ...target, targetOnlySecret: 'must-not-survive' }));

    await subject.copyOriginal(planned(minted));

    should(store.bytes(TARGET, minted.id, 'manifest')).deepEqual(store.bytes(SOURCE, minted.id, 'manifest'));
  });

  it('publishes the original first and the verbatim manifest last, then confirms both names', async () => {
    // The fork stamps `imported` as soon as import returns, so ORDER is the guarantee: a loss between the two
    // writes leaves a target the manifest-first replay reads as unmatched and rebuilds, never a manifest
    // vouching for bytes that are not beside it. The names are confirmed after the whole set is published.
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([3, 1, 4, 1, 5]));
    store.calls.length = 0;

    // Act
    await subject.copyOriginal(planned(minted));

    // Assert — the target-first proof reads manifest then (finding none) stops; the source is read; the original is
    // written before the manifest; every target name is read back last, in publication order.
    const target = (file: string): string => `${TARGET}/${minted.id}/${file}`;
    should(store.calls.filter(call => call.startsWith('write '))).deepEqual([
      `write ${target('original')}`,
      `write ${target('manifest')}`,
    ]);
    should(store.calls.slice(-2)).deepEqual([`read ${target('original')}`, `read ${target('manifest')}`]);
    should(store.calls[0]).equal(`read ${target('manifest')}`);
  });

  it('re-proves and republishes both artifacts on a matching replay without changing their bytes', async () => {
    // Arrange — a target-first replay that reads the planned bytes back has proved they are VISIBLE, which is
    // what a page cache offers a moment before power is cut. The receipt commits `imported` behind this return,
    // so it must establish the same durability the first copy did: the proved bytes go through the store again.
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([9, 9, 9, 9]));
    await subject.copyOriginal(planned(minted));
    const original = new Uint8Array(store.bytes(TARGET, minted.id, 'original') ?? []);
    const manifest = store.text(TARGET, minted.id, 'manifest');
    store.calls.length = 0;

    // Act
    await subject.copyOriginal(planned(minted));

    // Assert — manifest first, then the original (the order the read-only verification proves them in), both
    // written back, and nothing read from the source.
    const target = (file: string): string => `${TARGET}/${minted.id}/${file}`;
    should(store.calls.filter(call => call.startsWith('write '))).deepEqual([
      `write ${target('manifest')}`,
      `write ${target('original')}`,
    ]);
    should(store.calls.some(call => call.includes(`${SOURCE}/`))).be.false();
    should(store.bytes(TARGET, minted.id, 'original')).deepEqual(original);
    should(store.text(TARGET, minted.id, 'manifest')).equal(manifest);
  });

  it('verifies an already-imported target read-only, writing and repairing nothing', async () => {
    // The fork's pre-launch check may only REFUSE a drifted target, so it must leave the medium exactly
    // as it found it — no write, no repair — even though it proves the very same facts a replay does.
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([4, 2]));
    await subject.copyOriginal(planned(minted));
    store.calls.length = 0;

    // Act
    await subject.verifyTarget({ newSessionId: TARGET, expectedManifest: minted.expectedManifest });
    const drifted = await reject(
      subject.verifyTarget({
        newSessionId: TARGET,
        expectedManifest: { ...minted.expectedManifest, filename: 'renamed.pdf' },
      }),
    );

    // Assert
    should((drifted as SessionAttachmentCopyError).failure).equal('corrupt');
    should(store.calls.filter(call => call.startsWith('write '))).deepEqual([]);
  });

  it('reconstructs the exact attachment from the frozen plan after a loss before durability', async () => {
    // Arrange — power is cut in the manifest's publication window: the write was visible to that process but
    // nothing was flushed, so the manifest is gone after the reboot. The target-first replay reads that target as
    // unmatched and rebuilds both artifacts from the plan-verified source.
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([7, 7, 0, 7]), { encrypted: true });
    let publications = 0;
    store.afterWrite = written => {
      publications += 1;
      if (publications < 2) return;
      store.files.delete(written.key);
      throw new Error('power was lost before the manifest was persisted');
    };

    // Act — the interrupted copy, then a fresh copier after the reboot.
    const error = await reject(subject.copyOriginal(planned(minted)));
    store.afterWrite = () => undefined;
    await new FileSessionAttachmentCopier(store).copyOriginal(planned(minted));

    // Assert — the interrupted attempt did not return successfully, and the replay rebuilt the exact frozen
    // artifact: same original bytes, byte-identical verbatim manifest, locked state carried.
    should((error as Error).message).containEql('power was lost');
    should(store.bytes(TARGET, minted.id, 'original')).deepEqual(minted.bytes);
    should(store.bytes(TARGET, minted.id, 'manifest')).deepEqual(store.bytes(SOURCE, minted.id, 'manifest'));
  });

  it('recovers from another writer replacing the original mid-publication, and fails closed on a second time', async () => {
    // Arrange — after the original lands another writer puts different bytes under its name.
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([5, 4, 3, 2]));
    let substitutions = 1;
    store.afterWrite = written => {
      if (written.file === 'original' && substitutions-- > 0)
        store.put(TARGET, minted.id, 'original', new Uint8Array([0]));
    };

    // Act + Assert — one substitution is re-read and the whole set republished.
    await subject.copyOriginal(planned(minted));
    should(store.bytes(TARGET, minted.id, 'original')).deepEqual(minted.bytes);

    // A writer that substitutes every time is not chased forever: the call fails, so no receipt advances.
    const hostile = setup();
    const other = mintAttachment(hostile.store, SOURCE, new Uint8Array([6, 5, 4, 3]));
    hostile.store.afterWrite = written => {
      if (written.file === 'original') hostile.store.put(TARGET, other.id, 'original', new Uint8Array([0]));
    };
    const error = await reject(hostile.subject.copyOriginal(planned(other)));
    should((error as Error).message).containEql('replaced by another writer');
  });

  it('refuses to verify a target session id that is not usable, before asking the store anything', async () => {
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([7, 7]));
    store.calls.length = 0;

    // Act
    const error = await reject(
      subject.verifyTarget({ newSessionId: '../escape', expectedManifest: minted.expectedManifest }),
    );

    // Assert
    should(error).be.instanceOf(SessionAttachmentCopyError);
    should((error as SessionAttachmentCopyError).failure).equal('invalid');
    should((error as SessionAttachmentCopyError).message).match(/target session id is not usable/u);
    should(store.calls).deepEqual([]);
  });

  it('refuses a source manifest that is not JSON as corrupt, and leaves no target behind', async () => {
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([8, 8]));
    store.put(SOURCE, minted.id, 'manifest', '{not json');

    // Act
    const error = await reject(subject.copyOriginal(planned(minted)));

    // Assert
    should((error as SessionAttachmentCopyError).failure).equal('corrupt');
    should((error as SessionAttachmentCopyError).message).match(/manifest is not valid JSON/u);
    should(store.writesOf(TARGET)).deepEqual([]);
  });

  it('reports a source artifact that cannot be read as itself, not as a missing attachment', async () => {
    // Arrange — the original exists and cannot be read.
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([6, 6]));
    store.unreadable.add(`${SOURCE}/${minted.id}/original`);

    // Act
    const error = await reject(subject.copyOriginal(planned(minted)));

    // Assert
    should(error).not.be.instanceOf(SessionAttachmentCopyError);
    should((error as NodeJS.ErrnoException).code).equal('EISDIR');
  });

  it('verifies a target whose manifest is torn as drift, read-only, never as a parser error', async () => {
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([5, 5]));
    await subject.copyOriginal(planned(minted));
    store.put(TARGET, minted.id, 'manifest', '{"torn');
    store.calls.length = 0;

    // Act
    const verification = await reject(
      subject.verifyTarget({ newSessionId: TARGET, expectedManifest: minted.expectedManifest }),
    );

    // Assert: verification refuses the drift read-only; it never throws a parser's error.
    should((verification as SessionAttachmentCopyError).failure).equal('corrupt');
    should(store.text(TARGET, minted.id, 'manifest')).equal('{"torn');
    should(store.calls.filter(call => call.startsWith('write '))).deepEqual([]);
  });

  it('refuses an unusable identity or a target that aliases the source with an invalid failure', async () => {
    // Arrange
    const { store, subject } = setup();
    const minted = mintAttachment(store, SOURCE, new Uint8Array([4, 5, 6]));

    // Act + Assert — bad id.
    const badId = await reject(
      subject.copyOriginal({
        ...planned(minted),
        expectedManifest: { ...minted.expectedManifest, id: 'not-an-attachment-id' },
      }),
    );
    should((badId as SessionAttachmentCopyError).failure).equal('invalid');

    const mismatchedPlan = await reject(
      subject.copyOriginal({
        ...planned(minted),
        expectedManifest: { ...minted.expectedManifest, sha256: 'f'.repeat(64) },
      }),
    );
    should((mismatchedPlan as SessionAttachmentCopyError).failure).equal('invalid');

    // The explicit target cannot alias the source: that is the I4 guarantee in miniature.
    const sameSession = await reject(subject.copyOriginal(planned(minted, SOURCE)));
    should((sameSession as SessionAttachmentCopyError).failure).equal('invalid');
    should(store.writesOf(TARGET)).deepEqual([]);
  });
});
