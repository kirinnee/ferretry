import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskSessionsRoot, SimulatedCrash } from '@ferretry/kernel/testing';
import should from 'should';
import type { SessionTransferPlan } from '../../../../contract/transfer.ts';
import { FileSessionAttachmentCopier } from '../../../../daemon/adapters/transfer/attachment-copier.ts';
import { FileSessionTransferBriefWriter } from '../../../../daemon/adapters/transfer/brief-writer.ts';
import {
  type PublishableArtifact,
  TransferArtifactDurability,
} from '../../../../daemon/adapters/transfer/durable-artifact.ts';
import type { TranscriptProvenance } from '../../../../daemon/lib/protocol/session.ts';
import { SessionTransferImporter } from '../../../../daemon/lib/transfer/import.ts';
import type { SessionTransferEnvelope, TransferBriefWriter } from '../../../../daemon/lib/transfer/types.ts';
import { MemoryAttachmentStore } from './memory-attachment-store.ts';

/**
 * The durability contract the fork receipt is allowed to rely on.
 *
 * The fork stamps its durable receipt `imported` as soon as `importPlan` resolves, and a replay that
 * finds that phase skips import and REFUSES a target it cannot prove rather than repairing it. So the
 * one property this file exists to hold is that `importPlan` cannot resolve until every artifact the
 * import claims — the deterministic brief and each plan-pinned attachment original plus its verbatim
 * manifest — has been written through its port (which flushes before it resolves) and confirmed under its
 * final name.
 *
 * The two writers are the REAL adapters: the brief writer over the target's own folder on the kernel's `sessions`
 * root (a real disk) and the attachment copier over the attachment store fake; what is injected is the observation
 * point, and the crash is modelled right after the brief's write returned.
 */

const SOURCE = 'source-session';
const TARGET = 'target-session';
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const AT = '2026-08-06T07:00:00.000Z';
const CUT = { v: 1, byteOffset: 512, blockIndex: 0 } as const;

const PROVENANCE: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.claude',
  identity: 'minted',
  harnessSessionId: 'harness-1',
  file: '/home/agent/.claude/projects/x/harness-1.jsonl',
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

/** Lets the event loop run, so a write nobody awaited would resolve inside the yield. */
const yieldLoop = async (): Promise<void> => await new Promise<void>(resolve => setTimeout(resolve, 0));

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

/** Puts one source attachment into the store in the owner's layout. */
function mintSourceAttachment(store: MemoryAttachmentStore): SourceAttachment {
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
  store.put(SOURCE, id, 'original', bytes);
  store.put(SOURCE, id, 'manifest', JSON.stringify(stored));
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

/**
 * A brief writer over the TARGET's own `sessions` folder on a real disk (the brief is its `turns/turn-001.md`), whose
 * every write is observed (and may be slowed) before it lands and may be followed by `after` once it has landed.
 */
async function briefOver(
  observe: (event: string) => Promise<void> = async () => undefined,
  after: () => void = () => undefined,
): Promise<{ readonly writer: TransferBriefWriter; readonly stored: () => Promise<string> }> {
  const parent = await mkdtemp(`${tmpdir()}/fy-brief-durability-`);
  parents.push(parent);
  const disk = await diskSessionsRoot(parent, TARGET);
  const real = new FileSessionTransferBriefWriter(() => disk.root);
  return {
    writer: {
      write: async (newSessionId, document) => {
        await observe('brief:write');
        const file = await real.write(newSessionId, document);
        after();
        return file;
      },
    },
    stored: async () => await readFile(`${disk.folder}/turns/turn-001.md`, 'utf8'),
  };
}

describe('transfer artifact durability before receipt advancement', () => {
  it('cannot resolve importPlan, so no receipt can advance, until every artifact write has completed', async () => {
    // Arrange — the real brief writer and the real attachment copier, both observed at the write seam of their
    // ports. `settled` flips the instant `importPlan` resolves, and every write asserts it is still false AFTER
    // handing the event loop back: a write the adapter forgot to await would let import resolve inside that
    // yield, which is exactly the window a receipt would commit in.
    const store = new MemoryAttachmentStore();
    const attachment = mintSourceAttachment(store);
    const journal: string[] = [];
    const settled = { value: false };
    const hold = async (label: string): Promise<void> => {
      journal.push(label);
      await yieldLoop();
      should(settled.value).equal(false);
    };
    const brief = await briefOver(hold);
    const writeThrough = store.write.bind(store);
    store.write = async (sessionId, attachmentId, file, bytes) => {
      await hold(`attachment:${file}`);
      await writeThrough(sessionId, attachmentId, file, bytes);
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
        attachments: new FileSessionAttachmentCopier(store),
        brief: brief.writer,
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

    // Assert — every write of both artifacts precedes the stamp, in publication order: the attachment's original,
    // its verbatim manifest, then the brief.
    should(journal).deepEqual([
      'envelope:applied',
      'attachment:original',
      'attachment:manifest',
      'brief:write',
      'receipt:imported',
    ]);
    // And the artifacts the receipt now vouches for are the plan's, complete, with nothing half-written.
    should(outcome.copiedAttachmentIds).deepEqual([attachment.id]);
    should(outcome.briefPath.endsWith(`${TARGET}/turns/turn-001.md`)).be.true();
    should(await brief.stored()).containEql('carried.pdf');
    should(store.bytes(TARGET, attachment.id, 'original')).deepEqual(attachment.bytes);
    should(store.bytes(TARGET, attachment.id, 'manifest')).deepEqual(store.bytes(SOURCE, attachment.id, 'manifest'));
  });

  it('survives a crash right after the brief landed: the replay of the import completes and vouches for it', async () => {
    // Arrange — the brief is the LAST import step. The process dies after its write landed, before importPlan could
    // return, so no receipt advanced; the replay must accept what the first attempt left and finish. The brief is on
    // the target's own `sessions` folder, so the death is modelled right after its write returned, once.
    const store = new MemoryAttachmentStore();
    const attachment = mintSourceAttachment(store);
    let crash = true;
    const brief = await briefOver(undefined, () => {
      if (!crash) return;
      crash = false;
      throw new SimulatedCrash();
    });
    const importer = (): SessionTransferImporter =>
      new SessionTransferImporter(
        {
          conversation: {
            digestPinned: async () => ({
              sessionId: SOURCE,
              through: CUT,
              messages: [{ point: CUT, role: 'user', text: 'ship it', timestamp: AT }],
              omissions: [],
            }),
          },
          envelope: { apply: async () => undefined },
          attachments: new FileSessionAttachmentCopier(store),
          brief: brief.writer,
        },
        'fork',
      );
    // Act
    const crashed = await reject(importer().importPlan(plan(attachment), TARGET));
    const replayed = await importer().importPlan(plan(attachment), TARGET);

    // Assert
    should(crashed).be.instanceOf(SimulatedCrash);
    should(replayed.copiedAttachmentIds).deepEqual([attachment.id]);
    should(await brief.stored()).containEql('carried.pdf');
  });
});

/** An in-memory artifact whose reads and writes are logged and whose bytes a test can replace at will. */
interface MemoryArtifact extends PublishableArtifact {
  held: Uint8Array | undefined;
  afterWrite: () => void;
  read: () => Promise<Uint8Array | undefined>;
  write: (bytes: Uint8Array) => Promise<void>;
}

function memoryArtifact(
  log: string[],
  name: string,
  proves: (bytes: Uint8Array) => boolean,
  initial?: string,
): MemoryArtifact {
  const artifact: MemoryArtifact = {
    held: initial === undefined ? undefined : encode(initial),
    afterWrite: () => undefined,
    read: async () => {
      log.push(`read ${name}`);
      return artifact.held === undefined ? undefined : new Uint8Array(artifact.held);
    },
    write: async (bytes: Uint8Array) => {
      log.push(`write ${name}`);
      artifact.held = new Uint8Array(bytes);
      artifact.afterWrite();
    },
    proves,
  };
  return artifact;
}

const isText =
  (expected: string) =>
  (bytes: Uint8Array): boolean =>
    decode(bytes) === expected;

describe('TransferArtifactDurability', () => {
  it('returns from a first publication only after reading the name back holding the bytes it wrote', async () => {
    // Arrange
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'));

    // Act
    await new TransferArtifactDurability().materialize('brief', [{ ...artifact, bytes: 'frozen' }]);

    // Assert
    should(log).deepEqual(['write brief', 'read brief']);
  });

  it('never returns on a name that vanished between the proof and the return: it republishes', async () => {
    // Arrange — the replay proves the artifact, republishes it, and the name is gone before it is confirmed. Having
    // flushed bytes says nothing about what their NAME means afterwards, so the replay may not vouch for it.
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'), 'frozen');
    let removals = 0;
    artifact.afterWrite = () => {
      if (removals++ === 0) artifact.held = undefined;
    };
    const subject = new TransferArtifactDurability();

    // Act
    const durable = await subject.proveDurable([artifact]);
    const rebuilt = await subject.proveDurable([artifact]);

    // Assert — the first replay answers false (the caller then publishes its own bytes); nothing was vouched for.
    should(durable).equal(false);
    should(rebuilt).equal(false);
  });

  it('recovers when different bytes are put under a name once, and republishes its own', async () => {
    // Arrange — another writer lands DIFFERENT bytes after this attempt's write.
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'));
    let substitutions = 1;
    artifact.afterWrite = () => {
      if (substitutions-- > 0) artifact.held = encode('someone else');
    };

    // Act
    await new TransferArtifactDurability().materialize('brief', [{ ...artifact, bytes: 'frozen' }]);

    // Assert — the second round stands.
    should(decode(artifact.held)).equal('frozen');
  });

  it('confirms the SET: an earlier artifact replaced during a later publication is caught', async () => {
    // Arrange — the two-artifact case a per-file confirmation cannot cover. `original` is published first; the
    // manifest's whole publication is then a window in which another writer replaces `original`. The manifest
    // confirms its own name happily, so only a WHOLE-SET check before returning can see the set is no longer whole.
    const log: string[] = [];
    const original = memoryArtifact(log, 'original', isText('bytes'));
    const manifest = memoryArtifact(log, 'manifest', isText('manifest'));
    let substituted = false;
    manifest.afterWrite = () => {
      if (substituted) return;
      substituted = true;
      original.held = encode('replaced');
    };

    // Act
    await new TransferArtifactDurability().materialize('attachment', [
      { ...original, bytes: 'bytes' },
      { ...manifest, bytes: 'manifest' },
    ]);

    // Assert — the set was published again until every name held what was published.
    should(decode(original.held)).equal('bytes');
    should(decode(manifest.held)).equal('manifest');
    should(log.filter(entry => entry === 'write original')).have.length(2);
  });

  it('FAILS rather than returning when every publication and re-proof is replaced', async () => {
    // Arrange — a different value lands under the name after EVERY write. There is no bytes this attempt can
    // honestly vouch for, so the honest outcome is a rejection: the import stays retryable and no receipt may
    // advance. Returning here is the defect this case exists to forbid.
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'));
    artifact.afterWrite = () => {
      artifact.held = encode('someone else');
    };

    // Act
    const error = await reject(
      new TransferArtifactDurability().materialize('brief', [{ ...artifact, bytes: 'frozen' }]),
    );

    // Assert — refused, with the bound pinned: two publish-then-re-prove rounds, and then it stops instead of
    // chasing another writer for ever.
    should((error as Error).message).containEql('replaced by another writer');
    should(log.filter(entry => entry === 'write brief')).have.length(2);
  });

  it('proves the WHOLE set before it writes anything, so a failed proof persists nothing', async () => {
    // Arrange — the manifest proves, the original does not.
    const log: string[] = [];
    const manifest = memoryArtifact(log, 'manifest', isText('manifest'), 'manifest');
    const original = memoryArtifact(log, 'original', isText('bytes'), 'torn');

    // Act
    const durable = await new TransferArtifactDurability().proveDurable([manifest, original]);

    // Assert
    should(durable).equal(false);
    should(log).deepEqual(['read manifest', 'read original']);
  });

  it('republishes exactly the bytes it proved, in the order the artifacts were given', async () => {
    // Arrange
    const log: string[] = [];
    const manifest = memoryArtifact(log, 'manifest', isText('manifest'), 'manifest');
    const original = memoryArtifact(log, 'original', isText('bytes'), 'bytes');

    // Act
    const durable = await new TransferArtifactDurability().proveDurable([manifest, original]);

    // Assert — proof of each, then each written back, then each name confirmed.
    should(durable).equal(true);
    should(log).deepEqual([
      'read manifest',
      'read original',
      'write manifest',
      'write original',
      'read manifest',
      'read original',
    ]);
  });

  it('reads without writing when it only proves visibility', async () => {
    // Arrange
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'), 'frozen');

    // Act
    const visible = await new TransferArtifactDurability().proveVisible([artifact]);

    // Assert
    should(visible).equal(true);
    should(log).deepEqual(['read brief']);
  });

  it('surfaces an unreadable published artifact instead of silently republishing over it', async () => {
    // `prove` answers false for "absent" and for "not what the plan says". An IO failure is neither, and treating
    // it as "rebuild" would overwrite a target nobody could read.
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'));
    artifact.read = async () => {
      throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
    };

    const error = await reject(new TransferArtifactDurability().proveDurable([artifact]));

    should((error as { code?: string }).code).equal('ENOTDIR');
    should(log).deepEqual([]);
  });

  it('never tolerates a failed write: the publication fails so no receipt can advance behind it', async () => {
    // A write is where the BYTES become durable, so swallowing its failure is the one thing that would let a
    // receipt vouch for an artifact nothing had persisted.
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'));
    artifact.write = async () => {
      throw Object.assign(new Error('write answered EIO'), { code: 'EIO' });
    };

    const error = await reject(
      new TransferArtifactDurability().materialize('brief', [{ ...artifact, bytes: 'frozen' }]),
    );

    should((error as { code?: string }).code).equal('EIO');
  });

  it('surfaces a name that cannot be read for a reason other than being absent while confirming', async () => {
    // Arrange: the artifact is proved and republished, then reading the name back fails.
    const log: string[] = [];
    const artifact = memoryArtifact(log, 'brief', isText('frozen'), 'frozen');
    let reads = 0;
    const read = artifact.read;
    artifact.read = async () => {
      reads += 1;
      if (reads > 1) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      return await read();
    };

    // Act
    const error = await reject(new TransferArtifactDurability().proveDurable([artifact]));

    // Assert — not a lost race: the failure surfaces as the port's own error rather than a vouched return.
    should((error as { code?: string }).code).equal('ENOTDIR');
  });
});
