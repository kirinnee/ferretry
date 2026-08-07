import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AttachmentFacet, AttachmentFacetSchema, AttachmentViewSchema } from '@ferretry/protocol';
import type { TransferAttachmentCopier, TransferAttachmentCopyInput } from '../../lib/transfer/types.ts';
import { type DurableArtifactIo, TransferArtifactDurability } from './durable-artifact.ts';

const ATTACHMENT_ID = /^att_[0-9a-f]{64}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_NAME = /^[^/\\\0]+$/;
const STORED_MANIFEST_KEYS = new Set(['id', 'filename', 'mime', 'size', 'sha256', 'createdAt', 'encrypted']);

export type AttachmentCopyFailure = 'invalid' | 'not_found' | 'corrupt';

export class SessionAttachmentCopyError extends Error {
  constructor(
    readonly failure: AttachmentCopyFailure,
    message: string,
  ) {
    super(message);
  }
}

interface StoredAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly encrypted?: { readonly kind: 'pdf' };
}

type PlannedAttachment = AttachmentFacet['attachments'][number];

/**
 * Copies a source session's attachment into the explicit NEW-session key supplied by import.
 *
 * Implements `TransferAttachmentCopier` (seam `SessionTransferImportPorts.attachments`). The
 * source and target are both explicit, and the adapter refuses when they are equal — invariant I4.
 * The importer also supplies the complete manifest pinned in the durable plan. The source manifest
 * must match every planned fact — filename, MIME, timestamp and locked-encryption state as well as
 * content identity and size — and the copied bytes must match the pinned content facts. A coherently
 * rewritten source record therefore cannot change the target under one replayed plan. Attachment ids are
 * content addresses (`att_<sha256>`), so the id is reused; the ORIGINAL encrypted bytes plus the
 * manifest are copied verbatim, never re-encoded or round-tripped through `initialAttachments`.
 *
 * The manifest's metadata and its `encrypted: { kind: 'pdf' }` fact are preserved by the verbatim
 * copy; because the decrypted-plaintext cache is process-local and keyed by session, nothing of it is
 * (or could be) copied, so the new session begins LOCKED and re-prompts for the password. Emit a
 * `credential` omission upstream for each encrypted attachment copied.
 *
 * SOURCE IMMUTABILITY IS THE WHOLE CONSTRAINT (I1). This adapter only ever READS the source
 * directory — no handle is opened for writing, no byte is restamped — so the source session and its
 * descendants/waiters/pointers stay byte-for-byte untouched.
 *
 * PUBLICATION IS POWER-LOSS DURABLE (I5 with the receipt that follows it). The fork advances its
 * durable receipt to `imported` as soon as import returns, so a copy that was merely renamed could
 * leave a durable `imported` in front of a target attachment whose bytes — or whose directory entry —
 * never reached the medium, and the replay refuses that target instead of rebuilding it. Both
 * artifacts and the directory that names them are therefore flushed before this returns, through the
 * same {@link TransferArtifactDurability} the brief writer uses: the two artifacts one receipt
 * vouches for cannot be published under different guarantees. A target-first replay that already
 * matches the plan re-flushes what it found — on the handle it proved it from, then confirming both
 * names still resolve to those inodes — rather than trusting that reading it back means it is on the
 * medium.
 *
 * INTEGRATION NOTE: construct it with the same per-session layout `SessionAttachmentStore` uses —
 * `new FileSessionAttachmentCopier(sessionId => join(paths.home, 'attachments', daemonId,
 * sessionId))` — so the explicit `newSessionId` lands in the exact store a later `download` /
 * `unlock` reads.
 */
export class FileSessionAttachmentCopier implements TransferAttachmentCopier {
  private readonly durability: TransferArtifactDurability;

  constructor(
    private readonly attachmentsDirectory: (sessionId: string) => string,
    uniqueId: () => string = randomUUID,
    io?: DurableArtifactIo,
  ) {
    this.durability = new TransferArtifactDurability(uniqueId, io);
  }

  async copyOriginal(input: TransferAttachmentCopyInput): Promise<void> {
    this.assertSessionId(input.fromSessionId, 'source session');
    this.assertSessionId(input.newSessionId, 'target session');
    const expected = this.parseExpectedManifest(input.expectedManifest);
    if (input.fromSessionId === input.newSessionId) {
      throw new SessionAttachmentCopyError('invalid', 'source and target sessions must differ');
    }
    const sourceDirectory = join(this.attachmentsDirectory(input.fromSessionId), expected.id);
    const targetDirectory = join(this.attachmentsDirectory(input.newSessionId), expected.id);
    const durableAncestor = this.durableAncestorOf(input.newSessionId);

    // Replay checks the already-materialised target FIRST. If an earlier attempt copied this file
    // and a later attachment then failed, retry remains possible even when the source subsequently
    // disappears: the durable plan, not the mutable source directory, owns the expected bytes.
    //
    // An earlier attempt may also have published these exact bytes and died before flushing any of
    // them, so this proof PERSISTS what it proves — each file on the very handle its bytes were read
    // from — then persists the names and confirms both paths still resolve to the inodes it proved.
    // This return is what a receipt commits `imported` behind. Anything short of that falls through to
    // a rebuild from the plan-verified source rather than vouching for bytes it never flushed.
    const proofs = this.targetProofs(targetDirectory, expected);
    if (await this.durability.proveDurable(targetDirectory, durableAncestor, [proofs.manifest, proofs.original])) {
      return;
    }

    const manifestBytes = await this.readRequired(sourceDirectory, 'manifest.json');
    const stored = this.parseManifest(manifestBytes, expected.id);
    if (!sameManifest(this.plannedManifest(stored), expected)) {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment manifest does not match the transfer plan');
    }
    const originalBytes = await this.readRequired(sourceDirectory, 'original');
    if (originalBytes.byteLength !== expected.size || hash(originalBytes) !== expected.sha256) {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment original does not match the transfer plan');
    }

    // The original goes first and the manifest last, so a loss between them leaves a target the
    // target-first replay reads as unmatched and rebuilds, never a manifest vouching for bytes that
    // are not beside it. The manifest is copied VERBATIM so metadata (filename, mime, size, sha,
    // createdAt and the encrypted-pdf fact) is preserved exactly; locked state is the absence of a
    // decrypted cache, which the target never receives.
    //
    // Each publication also confirms its name still resolves to the inode it flushed, and refuses to
    // return on one a concurrent writer substituted — identical bytes included, because nothing here
    // synced THOSE bytes and a receipt would be recorded behind this call.
    await this.durability.materialize(targetDirectory, durableAncestor, [
      { ...proofs.original, bytes: originalBytes },
      { ...proofs.manifest, bytes: manifestBytes },
    ]);
  }

  /**
   * Proves an already-imported target still holds the exact plan-owned manifest and original bytes.
   * Unlike `copyOriginal`, this is read-only — it neither repairs nor flushes: a later fork phase
   * refuses drift instead of repairing it immediately before an agent is launched against evidence the
   * receipt claimed was complete.
   */
  async verifyTarget(input: Pick<TransferAttachmentCopyInput, 'newSessionId' | 'expectedManifest'>): Promise<void> {
    this.assertSessionId(input.newSessionId, 'target session');
    const expected = this.parseExpectedManifest(input.expectedManifest);
    const directory = join(this.attachmentsDirectory(input.newSessionId), expected.id);
    const proofs = this.targetProofs(directory, expected);
    if (!(await this.durability.proveVisible([proofs.manifest, proofs.original]))) {
      throw new SessionAttachmentCopyError(
        'corrupt',
        `target attachment ${expected.id} does not match the persisted transfer plan`,
      );
    }
  }

  private assertSessionId(value: string, label: string): void {
    if (!SESSION_ID.test(value) || value === '.' || value === '..') {
      throw new SessionAttachmentCopyError('invalid', `${label} id is not usable`);
    }
  }

  private async readRequired(directory: string, name: string): Promise<Buffer> {
    try {
      return await readFile(join(directory, name));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        throw new SessionAttachmentCopyError('not_found', `source attachment ${name} was not found`);
      }
      throw error;
    }
  }

  private parseExpectedManifest(manifest: TransferAttachmentCopyInput['expectedManifest']): PlannedAttachment {
    const parsed = AttachmentFacetSchema.safeParse({ attachments: [manifest] });
    const expected = parsed.success ? parsed.data.attachments[0] : undefined;
    if (
      expected === undefined ||
      !ATTACHMENT_ID.test(expected.id) ||
      expected.id !== `att_${expected.sha256}` ||
      !SAFE_NAME.test(expected.filename) ||
      expected.filename === '.' ||
      expected.filename === '..'
    ) {
      throw new SessionAttachmentCopyError('invalid', 'planned attachment manifest is not usable');
    }
    return expected;
  }

  private parseManifest(bytes: Buffer, attachmentId: string): StoredAttachment {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment manifest is not valid JSON');
    }
    const record: Readonly<Record<string, unknown>> =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Readonly<Record<string, unknown>>)
        : {};
    // The raw source manifest is copied verbatim. Reject fields outside the durable manifest before
    // that copy, otherwise an unplanned field could cross into the target (or survive there on
    // replay) even though the semantic comparison below never saw it.
    const hasOnlyDurableFields = Object.keys(record).every(key => STORED_MANIFEST_KEYS.has(key));
    const encrypted = record.encrypted;
    const encryptionIsDurable =
      encrypted === undefined ||
      (typeof encrypted === 'object' &&
        encrypted !== null &&
        !Array.isArray(encrypted) &&
        Object.keys(encrypted).length === 1 &&
        (encrypted as { readonly kind?: unknown }).kind === 'pdf');
    const durable = AttachmentViewSchema.safeParse({
      id: record.id,
      filename: record.filename,
      mime: record.mime,
      size: record.size,
      sha256: record.sha256,
      createdAt: record.createdAt,
      ...(encrypted === undefined ? {} : { encrypted: { kind: 'pdf', locked: true } }),
    });
    if (
      !durable.success ||
      !hasOnlyDurableFields ||
      !encryptionIsDurable ||
      durable.data.id !== attachmentId ||
      durable.data.id !== `att_${durable.data.sha256}` ||
      !SAFE_NAME.test(durable.data.filename) ||
      durable.data.filename === '.' ||
      durable.data.filename === '..'
    ) {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment manifest is invalid');
    }
    return {
      id: durable.data.id,
      filename: durable.data.filename,
      mime: durable.data.mime,
      size: durable.data.size,
      sha256: durable.data.sha256,
      createdAt: durable.data.createdAt,
      ...(encrypted === undefined ? {} : { encrypted: { kind: 'pdf' as const } }),
    };
  }

  private plannedManifest(stored: StoredAttachment): PlannedAttachment {
    return {
      id: stored.id,
      filename: stored.filename,
      mime: stored.mime,
      size: stored.size,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      encrypted: stored.encrypted === undefined ? null : { kind: 'pdf', locked: true },
    };
  }

  /**
   * The ONE description of what a target holding this plan's attachment looks like: the complete
   * manifest facts, and the exact content identity and size.
   *
   * Every caller proves exactly these, so repair, refusal and publication can never disagree about
   * what matching means. They are returned NAMED rather than as a list because the two orders differ
   * and both matter: proofs run manifest-first (it is published last, so a target missing it is one to
   * rebuild), publication runs original-first (a loss between them must read as unmatched).
   *
   * A proved manifest beside an unproved original is rebuilt from the source as a whole, so the
   * manifest flush that already happened is wasted work rather than a wrong claim: no name is
   * persisted on a failed proof, and the caller republishes both artifacts.
   */
  private targetProofs(
    directory: string,
    expected: PlannedAttachment,
  ): {
    readonly manifest: { readonly file: string; readonly proves: (bytes: Buffer) => boolean };
    readonly original: { readonly file: string; readonly proves: (bytes: Buffer) => boolean };
  } {
    return {
      manifest: {
        file: join(directory, 'manifest.json'),
        proves: (bytes: Buffer): boolean => {
          let stored: StoredAttachment;
          try {
            stored = this.parseManifest(bytes, expected.id);
          } catch (error) {
            // A torn or malformed target is recoverable: source verification replaces it atomically.
            if (error instanceof SessionAttachmentCopyError && error.failure === 'corrupt') return false;
            throw error;
          }
          return sameManifest(this.plannedManifest(stored), expected);
        },
      },
      original: {
        file: join(directory, 'original'),
        proves: (bytes: Buffer): boolean => bytes.byteLength === expected.size && hash(bytes) === expected.sha256,
      },
    };
  }

  /**
   * The ancestor whose own directory entry is taken as already durable: the STATE ROOT.
   *
   * The layout this adapter is composed against is `<state>/attachments/<daemonId>/<sessionId>`, so
   * the anchor is three levels above it. The attachments root is deliberately NOT the anchor, even
   * though a source attachment was read from under it: `SessionAttachmentStore` creates that whole
   * tree with a lazy recursive `mkdir` and no parent flush, so reading a source attachment proves the
   * root is VISIBLE and says nothing about whether its own name is on the medium. Anchoring there
   * would make this copy's durability depend on a flush nobody performs. Everything below the state
   * root is therefore persisted parent-first on the way down.
   *
   * Naming a higher ancestor is the safe direction: any ancestor of the artifact directory exists once
   * the tree is ensured, so a resolver composed at a different depth only widens the flushed chain —
   * it can never name a directory that is not there.
   */
  private durableAncestorOf(newSessionId: string): string {
    return dirname(dirname(dirname(this.attachmentsDirectory(newSessionId))));
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameManifest(left: PlannedAttachment, right: PlannedAttachment): boolean {
  return (
    left.id === right.id &&
    left.filename === right.filename &&
    left.mime === right.mime &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.createdAt === right.createdAt &&
    (left.encrypted === null) === (right.encrypted === null)
  );
}
