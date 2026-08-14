import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AttachmentFacet } from '@ferretry/protocol';
import should from 'should';
import {
  FileSessionAttachmentCopier,
  SessionAttachmentCopyError,
} from '../../../src/adapters/transfer/attachment-copier.ts';
import { type DurableArtifactIo, fsyncArtifactPath } from '../../../src/adapters/transfer/durable-artifact.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * Daemon-local attachment copying on a real filesystem. Every call names the explicit NEW session,
 * copies verified original bytes and the manifest under the same content address, carries locked
 * state, copies NO decrypted plaintext, and leaves the source byte-for-byte untouched.
 *
 * Everything here runs inside a throwaway directory; no state home is resolved.
 */

const DAEMON = 'daemon-1';
const SOURCE = 'source-session';
const TARGET = 'target-session';

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic temporary suffixes, so an atomic write is provable rather than incidental. */
function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `t${n}`;
  };
}

interface Minted {
  readonly id: string;
  readonly directory: string;
  readonly bytes: Uint8Array;
  readonly expectedManifest: AttachmentFacet['attachments'][number];
}

/** Writes a source attachment in the exact layout SessionAttachmentStore uses, and returns it. */
async function mintAttachment(
  root: string,
  sessionId: string,
  bytes: Uint8Array,
  options: { encrypted?: boolean; filename?: string } = {},
): Promise<Minted> {
  const id = `att_${sha(bytes)}`;
  const directory = join(root, 'attachments', DAEMON, sessionId, id);
  const manifest = {
    id,
    filename: options.filename ?? 'report.pdf',
    mime: 'application/pdf',
    size: bytes.byteLength,
    sha256: sha(bytes),
    createdAt: '2025-01-01T00:00:00+00:00',
    ...(options.encrypted ? { encrypted: { kind: 'pdf' } } : {}),
  };
  await Bun.write(join(directory, 'original'), bytes);
  await Bun.write(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return {
    id,
    directory,
    bytes,
    expectedManifest: {
      id,
      filename: manifest.filename,
      mime: manifest.mime,
      size: manifest.size,
      sha256: manifest.sha256,
      createdAt: manifest.createdAt,
      encrypted: options.encrypted ? { kind: 'pdf', locked: true } : null,
    },
  };
}

/** The target-keyed copier, constructed once and given the fresh id on every import write. */
function copier(root: string, io?: DurableArtifactIo): FileSessionAttachmentCopier {
  return new FileSessionAttachmentCopier(sessionId => join(root, 'attachments', DAEMON, sessionId), counter(), io);
}

interface DurabilityLedger {
  readonly events: string[];
  readonly io: DurableArtifactIo;
}

/**
 * Records every flush in order while still performing the REAL one.
 *
 * A stand-in recorder would make the durability assertions vacuous, so each hook calls through and
 * the optional callbacks are how a test inspects the filesystem — or simulates a power loss — at an
 * exact point in the publication sequence.
 */
function ledger(
  root: string,
  hooks: {
    readonly atDirectorySync?: (path: string) => Promise<void>;
    readonly atOpenFileSync?: () => Promise<void>;
  } = {},
): DurabilityLedger {
  const events: string[] = [];
  // The temporary root stands in for `<state>`, so `.` is the declared durable anchor itself.
  const name = (path: string): string => relative(root, path) || '.';
  return {
    events,
    io: {
      syncDirectory: async path => {
        events.push(`dir:${name(path)}`);
        await hooks.atDirectorySync?.(path);
        await fsyncArtifactPath(path);
      },
      syncOpenFile: async (handle, path) => {
        // A temporary being published, or an already-published file a replay proved from this handle.
        events.push(path.endsWith('.tmp') ? 'temp:fsync' : `file:${name(path)}`);
        await hooks.atOpenFileSync?.();
        await handle.sync();
      },
    },
  };
}

/**
 * The parent-first chain every target attachment publication persists.
 *
 * It starts at the STATE ROOT (`.` here), because the attachments root is itself created lazily by
 * `SessionAttachmentStore` with a recursive `mkdir` and no parent flush: reading a source attachment
 * from under it proves it is visible, never that its own name is on the medium. Every level below the
 * state root is therefore an entry this publication must persist.
 */
function chain(): readonly string[] {
  return ['.', join('attachments'), join('attachments', DAEMON), join('attachments', DAEMON, TARGET)].map(
    path => `dir:${path}`,
  );
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

describe('FileSessionAttachmentCopier', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('preserves the content address and original bytes, carrying locked state and no decrypted cache', async () => {
    // An encrypted attachment is copied as-is into the explicit target: same att_<sha> id, same original
    // bytes (still encrypted — never decrypted), manifest carrying encrypted:{kind:'pdf'}. The target
    // begins LOCKED because the decrypted-plaintext cache is process-local and session-keyed, so
    // nothing of it is (or could be) copied.
    // Arrange
    const home = await tempDirectory('transfer-attachment-copy');
    const encrypted = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x99, 0xaa, 0xff]); // not valid plaintext
    const minted = await mintAttachment(home, SOURCE, encrypted, { encrypted: true });

    // Act
    await copier(home).copyOriginal(planned(minted));

    // Assert — id and bytes preserved verbatim.
    const targetDirectory = join(home, 'attachments', DAEMON, TARGET, minted.id);
    const targetOriginal = join(targetDirectory, 'original');
    const targetManifest = join(targetDirectory, 'manifest.json');
    should(new Uint8Array(await readFile(targetOriginal))).deepEqual(encrypted);
    // Locked state + metadata carried: the manifest still names an encrypted pdf, and ONLY original +
    // manifest exist (no decrypted plaintext file was written).
    const manifest = JSON.parse(await readFile(targetManifest, 'utf8'));
    should((manifest as { encrypted: { kind: string } }).encrypted).deepEqual({ kind: 'pdf' });
    should((await readdir(targetDirectory)).sort()).deepEqual(['manifest.json', 'original']);
  });

  it('leaves the source byte-for-byte untouched', async () => {
    // Source immutability is seam invariant I1. The copier only ever READS the source, so its original,
    // manifest and directory listing are identical after a copy — and so are the mtimes.
    // Arrange
    const home = await tempDirectory('transfer-attachment-source');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const sourceOriginal = join(minted.directory, 'original');
    const sourceManifest = join(minted.directory, 'manifest.json');
    const beforeOriginal = await readFile(sourceOriginal);
    const beforeManifest = await readFile(sourceManifest);
    const beforeMtime = (await stat(sourceOriginal)).mtimeMs;

    // Act
    await copier(home).copyOriginal(planned(minted));

    // Assert — source content and listing unchanged.
    should(await readFile(sourceOriginal)).deepEqual(beforeOriginal);
    should(await readFile(sourceManifest)).deepEqual(beforeManifest);
    should((await readdir(minted.directory)).sort()).deepEqual(['manifest.json', 'original']);
    should((await stat(sourceOriginal)).mtimeMs).equal(beforeMtime);
  });

  it('is idempotent from the plan: a verified target survives later source mutation untouched', async () => {
    // A restart re-runs import, so a target that already holds the same bytes is not rewritten.
    // Arrange
    const home = await tempDirectory('transfer-attachment-idempotent');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([10, 20, 30]));
    const subject = copier(home);

    // Act
    await subject.copyOriginal(planned(minted));
    const targetDirectory = join(home, 'attachments', DAEMON, TARGET, minted.id);
    const mtimeBefore = (await stat(join(targetDirectory, 'original'))).mtimeMs;
    // A previously copied target is independently proved against the plan. Replay does not become
    // impossible merely because the source changed after a later attachment failed.
    await Bun.write(join(minted.directory, 'original'), new Uint8Array([99, 98, 97, 96]));
    await subject.copyOriginal(planned(minted));

    // Assert — second call did not throw and did not rewrite.
    should((await stat(join(targetDirectory, 'original'))).mtimeMs).equal(mtimeBefore);
  });

  it('repairs a torn target from source bytes that still match the plan', async () => {
    // Arrange
    const home = await tempDirectory('transfer-attachment-torn-target');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([8, 7, 6, 5]));
    const subject = copier(home);
    await subject.copyOriginal(planned(minted));
    const targetOriginal = join(home, 'attachments', DAEMON, TARGET, minted.id, 'original');
    await Bun.write(targetOriginal, new Uint8Array([0]));

    // Act
    await subject.copyOriginal(planned(minted));

    // Assert
    should(new Uint8Array(await readFile(targetOriginal))).deepEqual(minted.bytes);
  });

  it('copies several attachments under their respective content addresses', async () => {
    // Arrange
    const home = await tempDirectory('transfer-attachment-many');
    const one = await mintAttachment(home, SOURCE, new Uint8Array([1, 1, 1]));
    const two = await mintAttachment(home, SOURCE, new Uint8Array([2, 2, 2]));
    const subject = copier(home);

    // Act
    await subject.copyOriginal(planned(one));
    await subject.copyOriginal(planned(two));

    // Assert
    should(new Uint8Array(await readFile(join(home, 'attachments', DAEMON, TARGET, one.id, 'original')))).deepEqual(
      one.bytes,
    );
    should(new Uint8Array(await readFile(join(home, 'attachments', DAEMON, TARGET, two.id, 'original')))).deepEqual(
      two.bytes,
    );
  });

  it('refuses a missing source attachment with a not_found failure', async () => {
    // Arrange
    const home = await tempDirectory('transfer-attachment-missing');
    const phantom = 'att_0000000000000000000000000000000000000000000000000000000000000000';

    // Act + Assert
    const error = await reject(
      copier(home).copyOriginal({
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
    const home = await tempDirectory('transfer-attachment-corrupt');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([1, 2, 3]));
    await Bun.write(join(minted.directory, 'original'), new Uint8Array([9, 9, 9]));

    // Act + Assert
    const error = await reject(copier(home).copyOriginal(planned(minted)));
    should((error as SessionAttachmentCopyError).failure).equal('corrupt');
  });

  it('refuses a source coherently rewritten after planning even when its new bytes match its new manifest', async () => {
    // Arrange — this is the adversarial gap a manifest-only check misses: both source files agree,
    // but they no longer agree with the content identity frozen in the persisted transfer plan.
    const home = await tempDirectory('transfer-attachment-mutated');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([1, 2, 3, 4]));
    const input = planned(minted);
    const replacement = new Uint8Array([9, 8, 7, 6]);
    const manifestFile = join(minted.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    await Bun.write(join(minted.directory, 'original'), replacement);
    await Bun.write(
      manifestFile,
      JSON.stringify({ ...manifest, size: replacement.byteLength, sha256: sha(replacement) }),
    );

    // Act + Assert
    const error = await reject(copier(home).copyOriginal(input));
    should((error as SessionAttachmentCopyError).failure).equal('corrupt');
    should((error as Error).message).containEql('manifest');
  });

  it('refuses every planned manifest field drifting over unchanged bytes, including locked state', async () => {
    const mutations: readonly Readonly<Record<string, unknown>>[] = [
      { filename: 'renamed.pdf' },
      { mime: 'application/octet-stream' },
      { createdAt: '2025-01-02T00:00:00+00:00' },
      { encrypted: { kind: 'pdf' } },
    ];

    for (const [index, mutation] of mutations.entries()) {
      const home = await tempDirectory(`transfer-attachment-manifest-${index}`);
      const minted = await mintAttachment(home, SOURCE, new Uint8Array([1, 2, 3, index]));
      const manifestFile = join(minted.directory, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
      await Bun.write(manifestFile, JSON.stringify({ ...manifest, ...mutation }));

      const error = await reject(copier(home).copyOriginal(planned(minted)));
      should((error as SessionAttachmentCopyError).failure).equal('corrupt');
      should((error as Error).message).containEql('does not match the transfer plan');
    }
  });

  it('refuses an unplanned source manifest field instead of copying its raw bytes into the target', async () => {
    const home = await tempDirectory('transfer-attachment-source-extra-field');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([4, 4, 4]));
    const manifestFile = join(minted.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    await Bun.write(manifestFile, JSON.stringify({ ...manifest, sourceOnlySecret: 'must-not-cross' }));

    const error = await reject(copier(home).copyOriginal(planned(minted)));

    should((error as SessionAttachmentCopyError).failure).equal('corrupt');
    should((error as Error).message).containEql('manifest is invalid');
  });

  it('repairs target manifest metadata drift only from a source that still matches the plan', async () => {
    const home = await tempDirectory('transfer-attachment-target-manifest');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([7, 7, 7]));
    const subject = copier(home);
    await subject.copyOriginal(planned(minted));
    const sourceManifest = join(minted.directory, 'manifest.json');
    const targetManifest = join(home, 'attachments', DAEMON, TARGET, minted.id, 'manifest.json');
    const target = JSON.parse(await readFile(targetManifest, 'utf8')) as Record<string, unknown>;
    await Bun.write(targetManifest, JSON.stringify({ ...target, filename: 'drifted.txt' }));

    await subject.copyOriginal(planned(minted));

    should(await readFile(targetManifest)).deepEqual(await readFile(sourceManifest));
  });

  it('removes an unplanned target manifest field only after re-proving the source against the plan', async () => {
    const home = await tempDirectory('transfer-attachment-target-extra-field');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([6, 6, 6]));
    const subject = copier(home);
    await subject.copyOriginal(planned(minted));
    const sourceManifest = join(minted.directory, 'manifest.json');
    const targetManifest = join(home, 'attachments', DAEMON, TARGET, minted.id, 'manifest.json');
    const target = JSON.parse(await readFile(targetManifest, 'utf8')) as Record<string, unknown>;
    await Bun.write(targetManifest, JSON.stringify({ ...target, targetOnlySecret: 'must-not-survive' }));

    await subject.copyOriginal(planned(minted));

    should(await readFile(targetManifest)).deepEqual(await readFile(sourceManifest));
  });

  it('publishes both artifacts in write, file fsync, close, rename, artifact-directory fsync order', async () => {
    // The fork stamps `imported` as soon as import returns, so ORDER is the guarantee for both
    // artifacts: each temporary holds every byte before it is flushed, neither final name exists
    // until its temporary is durable, and the directory that names them is flushed after each rename.
    // Arrange
    const home = await tempDirectory('transfer-attachment-order');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([3, 1, 4, 1, 5]));
    const target = join(home, 'attachments', DAEMON, TARGET, minted.id);
    const sourceManifest = await readFile(join(minted.directory, 'manifest.json'));
    const observed: string[] = [];
    const recorder = ledger(home, {
      atOpenFileSync: async () => {
        observed.push(`flushing ${(await readdir(target)).sort().join(' + ')}`);
      },
      atDirectorySync: async path => {
        if (path !== target) return;
        observed.push(`published ${(await readdir(target)).sort().join(' + ')}`);
      },
    });

    // Act
    await copier(home, recorder.io).copyOriginal(planned(minted));

    // Assert — parents first, then original, then the verbatim manifest, each flushed after its rename.
    const artifact = `dir:${join('attachments', DAEMON, TARGET, minted.id)}`;
    should(recorder.events).deepEqual([...chain(), 'temp:fsync', artifact, 'temp:fsync', artifact]);
    // Each temporary is complete and unpublished at its flush; each rename is complete and the
    // temporary gone by the time the directory entry is persisted.
    should(observed).deepEqual([
      'flushing original.t1.tmp',
      'published original',
      'flushing manifest.json.t2.tmp + original',
      'published manifest.json + original',
    ]);
    should(new Uint8Array(await readFile(join(target, 'original')))).deepEqual(minted.bytes);
    should(await readFile(join(target, 'manifest.json'))).deepEqual(sourceManifest);
  });

  it('persists created directory entries parent-first, and again for a copy that created none', async () => {
    // Arrange — `mkdir(recursive)` reports only what THIS call created, so a copy standing in front of
    // a target tree another attempt made would otherwise skip the parent flushes its own return
    // depends on; that other attempt may have crashed before flushing any of them.
    const home = await tempDirectory('transfer-attachment-parents');
    const first = await mintAttachment(home, SOURCE, new Uint8Array([1, 1, 2, 3]));
    const second = await mintAttachment(home, SOURCE, new Uint8Array([5, 8, 13, 21]));
    const firstLedger = ledger(home);
    const secondLedger = ledger(home);

    // Act — the first copy creates the target tree; the second finds every level already there.
    await copier(home, firstLedger.io).copyOriginal(planned(first));
    await copier(home, secondLedger.io).copyOriginal(planned(second));

    // Assert — the same parent-first chain both times, from the state root down.
    should(firstLedger.events.slice(0, chain().length)).deepEqual([...chain()]);
    should(secondLedger.events.slice(0, chain().length)).deepEqual([...chain()]);
    should(secondLedger.events).deepEqual([
      ...chain(),
      'temp:fsync',
      `dir:${join('attachments', DAEMON, TARGET, second.id)}`,
      'temp:fsync',
      `dir:${join('attachments', DAEMON, TARGET, second.id)}`,
    ]);
  });

  it('never overwrites or removes a colliding writer temporary', async () => {
    // Arrange — a foreign attempt holds the exact temporary name this copy will mint.
    const home = await tempDirectory('transfer-attachment-temp-collision');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([2, 2, 2, 2]));
    const target = join(home, 'attachments', DAEMON, TARGET, minted.id);
    await mkdir(target, { recursive: true });
    const foreign = join(target, 'original.t1.tmp');
    await Bun.write(foreign, 'another writer is mid-flight');

    // Act
    const error = await reject(copier(home).copyOriginal(planned(minted)));

    // Assert — exclusive creation refused, foreign bytes intact, nothing published or cleaned up over it.
    should((error as { code?: string }).code).equal('EEXIST');
    should(await readFile(foreign, 'utf8')).equal('another writer is mid-flight');
    should(await readdir(target)).deepEqual(['original.t1.tmp']);
  });

  it('re-proves and re-flushes both artifacts on a matching replay without replacing their inodes', async () => {
    // Arrange — a target-first replay that reads the planned bytes back has proved they are VISIBLE,
    // which is what a page cache offers a moment before power is cut. The receipt commits `imported`
    // behind this return, so it must establish the same durability the first copy did.
    const home = await tempDirectory('transfer-attachment-replay-durability');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([9, 9, 9, 9]));
    await copier(home).copyOriginal(planned(minted));
    const target = join(home, 'attachments', DAEMON, TARGET, minted.id);
    const before = [await stat(join(target, 'original')), await stat(join(target, 'manifest.json'))];
    const recorder = ledger(home);

    // Act
    await copier(home, recorder.io).copyOriginal(planned(minted));

    // Assert — same inodes and mtimes, no temporary, and both artifacts plus the chain flushed.
    const after = [await stat(join(target, 'original')), await stat(join(target, 'manifest.json'))];
    should(after.map(entry => entry.ino)).deepEqual(before.map(entry => entry.ino));
    should(after.map(entry => entry.mtimeMs)).deepEqual(before.map(entry => entry.mtimeMs));
    should(recorder.events).deepEqual([
      // Manifest first, then the original — the same order and the same facts the read-only
      // verification proves — each flushed on the handle its bytes were proved from, then the names.
      `file:${join('attachments', DAEMON, TARGET, minted.id, 'manifest.json')}`,
      `file:${join('attachments', DAEMON, TARGET, minted.id, 'original')}`,
      ...chain(),
      `dir:${join('attachments', DAEMON, TARGET, minted.id)}`,
    ]);
    should((await readdir(target)).sort()).deepEqual(['manifest.json', 'original']);
  });

  it('verifies an already-imported target read-only, flushing and repairing nothing', async () => {
    // The fork's pre-launch check may only REFUSE a drifted target, so it must leave the medium exactly
    // as it found it — no flush, no repair — even though it proves the very same facts a replay does.
    // Arrange
    const home = await tempDirectory('transfer-attachment-verify-readonly');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([4, 2]));
    await copier(home).copyOriginal(planned(minted));
    const recorder = ledger(home);
    const subject = copier(home, recorder.io);

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
    should(recorder.events).deepEqual([]);
  });

  it('reconstructs the exact attachment from the frozen plan after a loss before durability', async () => {
    // Arrange — power is cut in the manifest's publication window: the rename was visible to that
    // process but nothing had been flushed, so the manifest is gone after the reboot. The target-first
    // replay reads that target as unmatched and rebuilds both artifacts from the plan-verified source.
    const home = await tempDirectory('transfer-attachment-lost');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([7, 7, 0, 7]), { encrypted: true });
    const target = join(home, 'attachments', DAEMON, TARGET, minted.id);
    const manifest = join(target, 'manifest.json');
    let publications = 0;
    const lost = ledger(home, {
      atDirectorySync: async path => {
        if (path !== target) return;
        publications += 1;
        if (publications < 2) return;
        await rm(manifest);
        throw new Error('power was lost before the artifact directory was persisted');
      },
    });

    // Act — the interrupted copy, then a fresh copier after the reboot.
    const error = await reject(copier(home, lost.io).copyOriginal(planned(minted)));
    await copier(home).copyOriginal(planned(minted));

    // Assert — the interrupted attempt did not return successfully, and the replay rebuilt the exact
    // frozen artifact: same original bytes, byte-identical verbatim manifest, locked state carried.
    should((error as Error).message).containEql('power was lost');
    should(new Uint8Array(await readFile(join(target, 'original')))).deepEqual(minted.bytes);
    should(await readFile(manifest)).deepEqual(await readFile(join(minted.directory, 'manifest.json')));
    should((await readdir(target)).sort()).deepEqual(['manifest.json', 'original']);
  });

  it('refuses an unusable identity or a target that aliases the source with an invalid failure', async () => {
    // Arrange
    const home = await tempDirectory('transfer-attachment-invalid');
    const minted = await mintAttachment(home, SOURCE, new Uint8Array([4, 5, 6]));

    // Act + Assert — bad id.
    const badId = await reject(
      copier(home).copyOriginal({
        ...planned(minted),
        expectedManifest: { ...minted.expectedManifest, id: 'not-an-attachment-id' },
      }),
    );
    should((badId as SessionAttachmentCopyError).failure).equal('invalid');

    const mismatchedPlan = await reject(
      copier(home).copyOriginal({
        ...planned(minted),
        expectedManifest: { ...minted.expectedManifest, sha256: 'f'.repeat(64) },
      }),
    );
    should((mismatchedPlan as SessionAttachmentCopyError).failure).equal('invalid');

    // The explicit target cannot alias the source: that is the I4 guarantee in miniature.
    const sameSession = await reject(copier(home).copyOriginal(planned(minted, SOURCE)));
    should((sameSession as SessionAttachmentCopyError).failure).equal('invalid');
  });
});
