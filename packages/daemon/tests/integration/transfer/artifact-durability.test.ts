import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, parse, relative } from 'node:path';
import type { SessionTransferPlan, TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import { FileSessionAttachmentCopier } from '../../../src/adapters/transfer/attachment-copier.ts';
import { FileSessionTransferBriefWriter } from '../../../src/adapters/transfer/brief-writer.ts';
import {
  type DurableArtifactIo,
  fsyncArtifactPath,
  TransferArtifactDurability,
} from '../../../src/adapters/transfer/durable-artifact.ts';
import { SessionTransferImporter } from '../../../src/lib/transfer/import.ts';
import type { SessionTransferEnvelope } from '../../../src/lib/transfer/types.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The durability contract the fork receipt is allowed to rely on.
 *
 * The fork stamps its durable receipt `imported` as soon as `importPlan` resolves, and a replay that
 * finds that phase skips import and REFUSES a target it cannot prove rather than repairing it. So the
 * one property this file exists to hold is that `importPlan` cannot resolve until every artifact the
 * import claims — the deterministic brief and each plan-pinned attachment original plus its verbatim
 * manifest — is on the medium under its final name.
 *
 * The two writers are the REAL adapters and the flushes are the REAL `fsync` calls, wrapped rather
 * than replaced: a recorder that only pretended to flush would make the claim vacuous. What is
 * injected is the observation point.
 */

const DAEMON = 'daemon-1';
const SOURCE = 'source-session';
const TARGET = 'target-session';
const AT = '2026-08-06T07:00:00.000Z';
const CUT = { v: 1, byteOffset: 512, blockIndex: 0 } as const;

const PROVENANCE: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.claude',
  identity: 'minted',
  harnessSessionId: 'harness-1',
  file: '/home/agent/.claude/projects/x/harness-1.jsonl',
};

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `t${n}`;
  };
}

/** The brief target's paths, plus a writer factory that can take a substituting IO. */
function briefTarget(root: string): {
  readonly turns: string;
  readonly file: string;
  readonly writer: (io?: DurableArtifactIo) => FileSessionTransferBriefWriter;
} {
  const sessions = join(root, 'state', 'sessions');
  const turns = join(sessions, TARGET, 'turns');
  return {
    turns,
    file: join(turns, 'turn-001.md'),
    writer: io => new FileSessionTransferBriefWriter(sessionId => join(sessions, sessionId), counter(), io),
  };
}

interface FlushLedger {
  /** `dev:ino` of every inode a REAL file flush was performed on. */
  readonly flushedInodes: Set<string>;
  readonly io: DurableArtifactIo;
}

/**
 * Records the identity of every inode that was really file-flushed, and lets a test drop a concurrent
 * writer into the directory-flush window.
 *
 * Byte equality is the trap this exists to close: a foreign inode carrying the same bytes reads as
 * correct while nothing in this process ever synced it, so the assertions ask which INODE the final
 * name resolves to and whether THAT one was flushed.
 */
function flushLedger(atDirectorySync: (path: string) => Promise<void> = async () => undefined): FlushLedger {
  const flushedInodes = new Set<string>();
  return {
    flushedInodes,
    io: {
      syncDirectory: async path => {
        await atDirectorySync(path);
        await fsyncArtifactPath(path);
      },
      syncOpenFile: async handle => {
        const info = await handle.stat();
        flushedInodes.add(`${info.dev}:${info.ino}`);
        await handle.sync();
      },
    },
  };
}

/** The `dev:ino` a name resolves to right now. */
async function identityOfName(file: string): Promise<string> {
  const info = await stat(file);
  return `${info.dev}:${info.ino}`;
}

/** Renames a byte-identical foreign file over `file`, as a concurrent writer that never flushed it would. */
async function substitute(directory: string, file: string, bytes: string, tag: string): Promise<string> {
  const foreign = join(directory, `concurrent-${tag}`);
  await Bun.write(foreign, bytes);
  await rename(foreign, file);
  return await identityOfName(file);
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

interface SourceAttachment {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly manifest: SessionTransferPlan['facets']['attachments']['attachments'][number];
}

/** Writes one source attachment in the exact layout `SessionAttachmentStore` uses. */
async function mintSourceAttachment(home: string): Promise<SourceAttachment> {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = `att_${sha256}`;
  const stored = {
    id,
    filename: 'carried.pdf',
    mime: 'application/pdf',
    size: bytes.byteLength,
    sha256,
    createdAt: AT,
  };
  const directory = join(home, 'attachments', DAEMON, SOURCE, id);
  await Bun.write(join(directory, 'original'), bytes);
  await Bun.write(join(directory, 'manifest.json'), JSON.stringify(stored));
  return { id, bytes, manifest: { ...stored, encrypted: null } };
}

/** A complete plan carrying one message and one attachment, as prepare could have frozen it. */
function plan(attachment: SourceAttachment): SessionTransferPlan {
  return {
    v: 1,
    planId: 'plan-1',
    preparedAt: AT,
    source: {
      sessionId: SOURCE,
      incarnation: 'inc-1',
      runtimeGeneration: 3,
      harness: 'claude',
      agent: 'account-a',
      model: 'opus',
      teammate: null,
      name: 'zelda',
      label: 'teammate',
      transcriptProvenance: PROVENANCE,
      cutMessagePoint: CUT,
    },
    target: {
      accountId: 'account-b',
      agent: 'account-b',
      harness: 'claude',
      model: 'opus',
      effort: 'high',
      contextWindow: 200_000,
    },
    durable: {
      cwd: '/work/repo',
      mode: 'auto',
      parentSessionId: null,
      boardAccess: 'none',
      label: 'teammate',
      harnessFlags: [],
      remoteControl: true,
      intervalSeconds: 30,
      timeoutSeconds: 600,
      nudgeAfterSeconds: 120,
      killAfterSeconds: 900,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    },
    facets: {
      conversation: { messages: [{ point: CUT, role: 'user', text: 'ship it', timestamp: AT }] },
      attachments: { attachments: [attachment.manifest] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work/repo', head: 'abc123', status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  };
}

describe('transfer artifact durability before receipt advancement', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('cannot resolve importPlan, so no receipt can advance, until every artifact flush has completed', async () => {
    // Arrange — the real brief writer and the real attachment copier, both observed through the same
    // injected flush seam. `settled` flips the instant `importPlan` resolves, and every flush asserts
    // it is still false AFTER handing the event loop back: a flush the writer forgot to await would
    // let import resolve inside that yield, which is exactly the window a receipt would commit in.
    const home = await tempDirectory('transfer-import-durability');
    const attachment = await mintSourceAttachment(home);
    const journal: string[] = [];
    const settled = { value: false };
    // The temporary home stands in for `<state>`, so `.` is the attachment chain's declared anchor.
    const name = (path: string): string => relative(home, path) || '.';
    const hold = async (label: string, flush: () => Promise<void>): Promise<void> => {
      journal.push(label);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      should(settled.value).equal(false);
      await flush();
    };
    const io: DurableArtifactIo = {
      syncDirectory: async path => await hold(`dir:${name(path)}`, async () => await fsyncArtifactPath(path)),
      syncOpenFile: async (handle, path) =>
        await hold(path.endsWith('.tmp') ? 'temp:fsync' : `file:${name(path)}`, async () => await handle.sync()),
    };
    const importer = new SessionTransferImporter(
      {
        conversation: {
          digestPinned: async () => ({
            sessionId: SOURCE,
            through: CUT,
            messages: [{ point: CUT, role: 'user', text: 'ship it', timestamp: AT }],
            omissions: [],
          }),
        },
        envelope: {
          apply: async (_newSessionId: string, _envelope: SessionTransferEnvelope) => {
            journal.push('envelope:applied');
          },
        },
        attachments: new FileSessionAttachmentCopier(
          sessionId => join(home, 'attachments', DAEMON, sessionId),
          counter(),
          io,
        ),
        brief: new FileSessionTransferBriefWriter(
          sessionId => join(home, 'state', 'sessions', sessionId),
          counter(),
          io,
        ),
      },
      'fork',
    );

    // Act — the receipt stamp is modelled at the earliest moment import could be observed to resolve.
    const importing = importer.importPlan(plan(attachment), TARGET);
    const stamp = importing.then(
      () => {
        settled.value = true;
        journal.push('receipt:imported');
      },
      () => undefined,
    );
    const outcome = await importing;
    await stamp;

    // Assert — every flush of both artifacts precedes the stamp, in publication order: the attachment's
    // parent chain, its original, its verbatim manifest, then the brief's chain and the brief itself.
    const target = join('attachments', DAEMON, TARGET, attachment.id);
    should(journal).deepEqual([
      'envelope:applied',
      // The attachment chain is anchored at the state root, because the attachments root below it is
      // created lazily by the attachment store with no parent flush of its own.
      'dir:.',
      'dir:attachments',
      `dir:${join('attachments', DAEMON)}`,
      `dir:${join('attachments', DAEMON, TARGET)}`,
      'temp:fsync',
      `dir:${target}`,
      'temp:fsync',
      `dir:${target}`,
      // The brief chain is anchored at the state root for the same reason: nobody flushes the entry
      // naming `<sessions>` inside it.
      'dir:state',
      `dir:${join('state', 'sessions')}`,
      `dir:${join('state', 'sessions', TARGET)}`,
      'temp:fsync',
      `dir:${join('state', 'sessions', TARGET, 'turns')}`,
      'receipt:imported',
    ]);
    // And the artifacts the receipt now vouches for are the plan's, complete, with nothing half-written.
    should(outcome.copiedAttachmentIds).deepEqual([attachment.id]);
    should(outcome.briefPath).equal(join(home, 'state', 'sessions', TARGET, 'turns', 'turn-001.md'));
    should(await readFile(outcome.briefPath, 'utf8')).containEql('carried.pdf');
    should(new Uint8Array(await readFile(join(home, target, 'original')))).deepEqual(attachment.bytes);
    should((await readdir(join(home, target))).sort()).deepEqual(['manifest.json', 'original']);
  });

  it('returns from a first publication only on the inode it flushed itself', async () => {
    // The baseline the two substitution cases below are measured against: with nobody racing, the name
    // resolves to the temporary this attempt wrote, flushed and renamed — not merely to equal bytes.
    // Arrange
    const root = await tempDirectory('transfer-artifact-publication-confirmed');
    const document = '# Frozen transfer brief\n';
    const { file, writer } = briefTarget(root);
    const ledger = flushLedger();

    // Act
    const written = await writer(ledger.io).write(TARGET, document);

    // Assert
    should(written).equal(file);
    should(ledger.flushedInodes.has(await identityOfName(file))).be.true();
  });

  it('never returns on a name that stopped resolving to the inode it proved', async () => {
    // Arrange — the name disappears between the proof and the return. Flushing an inode says nothing
    // about what its NAME means afterwards, so the replay may not vouch for it; it republishes the
    // frozen document instead, which it can always do.
    const root = await tempDirectory('transfer-artifact-name-gone');
    const document = '# Frozen transfer brief\n';
    const { turns, file, writer } = briefTarget(root);
    await writer().write(TARGET, document);
    let removals = 0;
    const ledger = flushLedger(async path => {
      if (path !== turns || removals > 0) return;
      removals += 1;
      await rm(file);
    });

    // Act
    const written = await writer(ledger.io).write(TARGET, document);

    // Assert — republished, returned on an inode this attempt flushed, and nothing left behind.
    should(await readFile(written, 'utf8')).equal(document);
    should(ledger.flushedInodes.has(await identityOfName(file))).be.true();
    should(await readdir(turns)).deepEqual(['turn-001.md']);
  });

  it('re-proves and FLUSHES the substituted inode when a rename beats its replay proof', async () => {
    // Arrange — a concurrent writer of the same frozen document lands its own copy over the name
    // between the proof and the return, and never flushes it. One substitution is a race worth
    // re-reading: the second proof flushes the inode that is actually there, on that inode's own
    // handle, so nothing needs republishing — and the return is about a file this attempt made durable.
    const root = await tempDirectory('transfer-artifact-substituted-once');
    const document = '# Frozen transfer brief\n';
    const { turns, file, writer } = briefTarget(root);
    await writer().write(TARGET, document);
    let substitutions = 0;
    let substituted = '';
    const ledger = flushLedger(async path => {
      if (path !== turns || substitutions > 0) return;
      substitutions += 1;
      substituted = await substitute(turns, file, document, 'replay');
    });

    // Act
    const written = await writer(ledger.io).write(TARGET, document);

    // Assert — returned on the substituted inode, and that inode was itself file-flushed.
    should(await readFile(written, 'utf8')).equal(document);
    should(await identityOfName(file)).equal(substituted);
    should(ledger.flushedInodes.has(substituted)).be.true();
    should(await readdir(turns)).deepEqual(['turn-001.md']);
  });

  it('re-proves and FLUSHES the substituted inode when a rename beats its own publication', async () => {
    // Arrange — this is the hole a publication that only renamed and flushed the directory would leave:
    // a concurrent writer replaces the just-published name inside the artifact-directory flush window
    // with byte-identical content it never synced. The publication therefore CONFIRMS its name, sees
    // the substitution, and re-proves what is there on its own handle before returning.
    const root = await tempDirectory('transfer-artifact-substituted-publication');
    const document = '# Frozen transfer brief\n';
    const { turns, file, writer } = briefTarget(root);
    let substitutions = 0;
    let substituted = '';
    const ledger = flushLedger(async path => {
      if (path !== turns || substitutions > 0) return;
      substitutions += 1;
      substituted = await substitute(turns, file, document, 'publication');
    });

    // Act — nothing is published yet, so the first flush of `turns` is this publication's own.
    const written = await writer(ledger.io).write(TARGET, document);

    // Assert — the name resolves to the foreign inode, and this attempt flushed THAT inode rather than
    // returning because the bytes happened to match.
    should(await readFile(written, 'utf8')).equal(document);
    should(await identityOfName(file)).equal(substituted);
    should(ledger.flushedInodes.has(substituted)).be.true();
    should(await readdir(turns)).deepEqual(['turn-001.md']);
  });

  it('confirms the SET: an earlier artifact substituted during a later publication is caught', async () => {
    // Arrange — the two-artifact case a per-file confirmation cannot cover. `original` is published and
    // confirmed first; the manifest's whole publication is then a window in which a concurrent writer
    // renames a byte-identical, never-flushed inode onto `original`. The manifest confirms its own name
    // happily, so only a WHOLE-SET check before returning can see that the set is no longer durable.
    const home = await tempDirectory('transfer-artifact-set-substituted');
    const attachment = await mintSourceAttachment(home);
    const target = join(home, 'attachments', DAEMON, TARGET, attachment.id);
    const original = join(target, 'original');
    const manifest = join(target, 'manifest.json');
    let artifactFlushes = 0;
    let substituted = '';
    const ledger = flushLedger(async path => {
      if (path !== target) return;
      artifactFlushes += 1;
      // Flush 1 publishes `original`; flush 2 is inside the MANIFEST's publication.
      if (artifactFlushes !== 2) return;
      const foreign = join(target, 'concurrent-original');
      await Bun.write(foreign, attachment.bytes);
      await rename(foreign, original);
      substituted = await identityOfName(original);
    });
    const copier = new FileSessionAttachmentCopier(
      sessionId => join(home, 'attachments', DAEMON, sessionId),
      counter(),
      ledger.io,
    );

    // Act
    await copier.copyOriginal({
      fromSessionId: SOURCE,
      newSessionId: TARGET,
      expectedManifest: attachment.manifest,
    });

    // Assert — the substituted inode is what `original` names, and this attempt proved and FLUSHED that
    // inode before returning rather than returning because its bytes happened to match.
    should(await identityOfName(original)).equal(substituted);
    should(ledger.flushedInodes.has(substituted)).be.true();
    should(ledger.flushedInodes.has(await identityOfName(manifest))).be.true();
    should(new Uint8Array(await readFile(original))).deepEqual(attachment.bytes);
    should((await readdir(target)).sort()).deepEqual(['manifest.json', 'original']);
  });

  it('FAILS rather than returning when every publication and re-proof is substituted', async () => {
    // Arrange — substitution on EVERY directory flush, always with byte-identical content that is
    // never synced. There is no inode this attempt can honestly vouch for, so the honest outcome is a
    // rejection: the import stays retryable and no receipt may advance. Returning here — which byte
    // equality alone would have allowed — is the defect this case exists to forbid.
    const root = await tempDirectory('transfer-artifact-substituted-always');
    const document = '# Frozen transfer brief\n';
    const { turns, file, writer } = briefTarget(root);
    let substitutions = 0;
    const ledger = flushLedger(async path => {
      if (path !== turns) return;
      substitutions += 1;
      await substitute(turns, file, document, `${substitutions}`);
    });

    // Act
    const error = await reject(writer(ledger.io).write(TARGET, document));

    // Assert — refused, with the bound pinned: two publish-then-re-prove rounds, each re-proof taking
    // its own two attempts, and then it stops instead of chasing another writer for ever.
    should((error as Error).message).containEql('renamed over by another writer');
    should(substitutions).equal(6);
    // The foreign inode is what the name holds, and no temporary of this attempt was left behind.
    should(await readFile(file, 'utf8')).equal(document);
    should(await readdir(turns)).deepEqual(['turn-001.md']);
  });

  it('cleans up only the temporary it created when a publication cannot complete', async () => {
    // Arrange — the final name is taken by a non-empty directory, so the atomic rename cannot succeed.
    const root = await tempDirectory('transfer-artifact-publish-failure');
    const directory = join(root, 'artifacts');
    const durability = new TransferArtifactDurability(() => 'mine');
    await durability.ensureDirectory(directory, root);
    const file = join(directory, 'original');
    await mkdir(file, { recursive: true });
    await Bun.write(join(file, 'occupied'), 'not ours');

    // Act
    const error = await reject(durability.publish(directory, file, new Uint8Array([1, 2, 3])));

    // Assert — our own temporary is gone, and the colliding entry is exactly as it was.
    should(error).be.instanceOf(Error);
    should(await readdir(directory)).deepEqual(['original']);
    should(await readdir(file)).deepEqual(['occupied']);
  });

  it('tolerates a filesystem that cannot flush a directory, and only those three codes', async () => {
    // The repo-standard tolerance (`StateFileSystem`, the session effect ledger): some filesystems
    // cannot fsync a directory at all, and refusing to publish there would make the daemon unusable
    // rather than safer. The consequence is narrow and stated: the NAME degrades to page-cache
    // visibility. Any other failure is a real one and is never swallowed.
    const root = await tempDirectory('transfer-artifact-directory-tolerance');
    const directory = join(root, 'artifacts');
    const failing = (code: string): DurableArtifactIo => ({
      syncDirectory: async () => {
        throw Object.assign(new Error(`directory flush answered ${code}`), { code });
      },
      syncOpenFile: async handle => await handle.sync(),
    });

    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
      const durability = new TransferArtifactDurability(() => code, failing(code));
      const file = join(directory, `tolerated-${code}`);
      await durability.ensureDirectory(directory, root);
      // Confirmed as well as published: a tolerated directory flush is still a publication, and the
      // name it answers with is the inode it flushed.
      should(await durability.publish(directory, file, `published despite ${code}\n`)).equal(
        await identityOfName(file),
      );
      should(await readFile(file, 'utf8')).equal(`published despite ${code}\n`);
    }

    // Anything else fails the publication, so no receipt can advance behind it.
    const strict = new TransferArtifactDurability(() => 'eio', failing('EIO'));
    const error = await reject(strict.ensureDirectory(directory, root));
    should((error as { code?: string }).code).equal('EIO');
  });

  it('never tolerates a failed file flush: the publication fails and cleans up its own temporary', async () => {
    // A file flush is where the BYTES become durable, so swallowing its failure is the one thing that
    // would let a receipt vouch for an artifact nothing had persisted.
    const root = await tempDirectory('transfer-artifact-file-strictness');
    const directory = join(root, 'artifacts');
    const io: DurableArtifactIo = {
      syncDirectory: async path => await fsyncArtifactPath(path),
      syncOpenFile: async () => {
        // Deliberately one of the codes a DIRECTORY flush tolerates: the asymmetry is the point.
        throw Object.assign(new Error('file flush answered EINVAL'), { code: 'EINVAL' });
      },
    };
    const durability = new TransferArtifactDurability(() => 'mine', io);
    await durability.ensureDirectory(directory, root);

    const error = await reject(durability.publish(directory, join(directory, 'original'), new Uint8Array([1])));

    should((error as { code?: string }).code).equal('EINVAL');
    // Nothing published, and the temporary this attempt created is gone.
    should(await readdir(directory)).deepEqual([]);
  });

  it('surfaces an unreadable published artifact instead of silently republishing over it', async () => {
    // `prove` answers false for "absent" and for "not what the plan says". An IO failure is neither,
    // and treating it as "rebuild" would overwrite a target nobody could read.
    const root = await tempDirectory('transfer-artifact-unreadable');
    await Bun.write(join(root, 'not-a-directory'), 'a file, not a directory');

    const error = await reject(
      new TransferArtifactDurability().prove(join(root, 'not-a-directory', 'original'), () => true),
    );

    should((error as { code?: string }).code).equal('ENOTDIR');
  });

  it('widens the persisted chain to the filesystem root when the declared ancestor is not on the path', async () => {
    // Arrange — the claim here is which directories the chain NAMES and in what order, so this is the
    // one place a pure recorder is honest: flushing every ancestor of a throwaway directory, up to and
    // including the filesystem root, would prove nothing extra about the walk.
    const root = await tempDirectory('transfer-artifact-chain');
    const directory = join(root, 'one', 'two');
    const flushed: string[] = [];
    const recorder: DurableArtifactIo = {
      syncDirectory: async path => {
        flushed.push(path);
      },
      syncOpenFile: async () => undefined,
    };

    // Act — an ancestor that is not on this path must widen the chain, never walk forever.
    await new TransferArtifactDurability(() => 'x', recorder).ensureDirectory(
      directory,
      join(root, 'not', 'an', 'ancestor'),
    );

    // Assert — parent-first from the filesystem root down to the artifact directory's own parent.
    should(flushed[0]).equal(parse(directory).root);
    should(flushed[flushed.length - 1]).equal(join(root, 'one'));
    should(flushed.every((path, index) => index === 0 || dirname(path) === flushed[index - 1])).be.true();
    should((await readdir(join(root, 'one'))).sort()).deepEqual(['two']);
  });
});
