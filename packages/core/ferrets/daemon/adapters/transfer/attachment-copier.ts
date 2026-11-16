import { createHash } from 'node:crypto';
import { type AttachmentFacet, AttachmentFacetSchema } from '../../../contract/transfer.ts';
import type { AttachmentFile, TransferAttachmentStore, TransferStoredManifest } from '../../lib/transfer/ports.ts';
import type { TransferAttachmentCopier, TransferAttachmentCopyInput } from '../../lib/transfer/types.ts';
import { type PublishableArtifact, TransferArtifactDurability } from './durable-artifact.ts';

const ATTACHMENT_ID = /^att_[0-9a-f]{64}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_NAME = /^[^/\\\0]+$/;

const decoder = new TextDecoder();

export type AttachmentCopyFailure = 'invalid' | 'not_found' | 'corrupt';

export class SessionAttachmentCopyError extends Error {
  constructor(
    readonly failure: AttachmentCopyFailure,
    message: string,
  ) {
    super(message);
  }
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
 * tree — it never writes to the source session's key, no byte is restamped — so the source session
 * and its descendants/waiters/pointers stay byte-for-byte untouched.
 *
 * PUBLICATION IS POWER-LOSS DURABLE (I5 with the receipt that follows it). The fork advances its
 * durable receipt to `imported` as soon as import returns, so a copy that was merely visible could
 * leave a durable `imported` in front of a target attachment whose bytes never reached the medium,
 * and the replay refuses that target instead of rebuilding it. Both artifacts are therefore written
 * through the attachment store (whose `write` is atomic and durable when it resolves) and confirmed
 * before this returns, through the same {@link TransferArtifactDurability} the brief writer uses: the
 * two artifacts one receipt vouches for cannot be published under different guarantees. A target-first
 * replay that already matches the plan republishes what it found — then confirms both names still hold
 * those bytes — rather than trusting that reading it back means it is on the medium.
 *
 * WHERE THE BYTES LIVE IS THE ATTACHMENT OWNER'S. The store is injected (`TransferAttachmentStore`): the
 * explicit `newSessionId` lands in the exact tree a later `download` / `unlock` reads because it is the owner's
 * own writer that puts it there.
 */
export class FileSessionAttachmentCopier implements TransferAttachmentCopier {
  private readonly durability = new TransferArtifactDurability();

  constructor(private readonly store: TransferAttachmentStore) {}

  async copyOriginal(input: TransferAttachmentCopyInput): Promise<void> {
    this.assertSessionId(input.fromSessionId, 'source session');
    this.assertSessionId(input.newSessionId, 'target session');
    const expected = this.parseExpectedManifest(input.expectedManifest);
    if (input.fromSessionId === input.newSessionId) {
      throw new SessionAttachmentCopyError('invalid', 'source and target sessions must differ');
    }

    // Replay checks the already-materialised target FIRST. If an earlier attempt copied this file
    // and a later attachment then failed, retry remains possible even when the source subsequently
    // disappears: the durable plan, not the mutable source tree, owns the expected bytes.
    //
    // An earlier attempt may also have published these exact bytes and died before they were durable,
    // so this proof PERSISTS what it proves — the proved bytes are republished through the store and
    // both names are confirmed to still hold them. This return is what a receipt commits `imported`
    // behind. Anything short of that falls through to a rebuild from the plan-verified source rather
    // than vouching for bytes it never made durable.
    const proofs = this.targetProofs(input.newSessionId, expected);
    if (await this.durability.proveDurable([proofs.manifest, proofs.original])) return;

    const manifestBytes = await this.readRequired(input.fromSessionId, expected.id, 'manifest');
    const stored = this.parseManifest(manifestBytes, expected.id);
    if (!sameManifest(this.plannedManifest(stored), expected)) {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment manifest does not match the transfer plan');
    }
    const originalBytes = await this.readRequired(input.fromSessionId, expected.id, 'original');
    if (originalBytes.byteLength !== expected.size || hash(originalBytes) !== expected.sha256) {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment original does not match the transfer plan');
    }

    // The original goes first and the manifest last, so a loss between them leaves a target the
    // target-first replay reads as unmatched and rebuilds, never a manifest vouching for bytes that
    // are not beside it. The manifest is copied VERBATIM so metadata (filename, mime, size, sha,
    // createdAt and the encrypted-pdf fact) is preserved exactly; locked state is the absence of a
    // decrypted cache, which the target never receives.
    //
    // Each publication is also confirmed to still hold the bytes it published, and the call refuses to
    // return on a name another writer substituted, because nothing here made THOSE bytes durable and a
    // receipt would be recorded behind this call.
    await this.durability.materialize(`${input.newSessionId}/${expected.id}`, [
      { ...proofs.original, bytes: originalBytes },
      { ...proofs.manifest, bytes: manifestBytes },
    ]);
  }

  /**
   * Proves an already-imported target still holds the exact plan-owned manifest and original bytes.
   * Unlike `copyOriginal`, this is read-only — it neither repairs nor writes: a later fork phase
   * refuses drift instead of repairing it immediately before an agent is launched against evidence the
   * receipt claimed was complete.
   */
  async verifyTarget(input: Pick<TransferAttachmentCopyInput, 'newSessionId' | 'expectedManifest'>): Promise<void> {
    this.assertSessionId(input.newSessionId, 'target session');
    const expected = this.parseExpectedManifest(input.expectedManifest);
    const proofs = this.targetProofs(input.newSessionId, expected);
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

  private async readRequired(sessionId: string, attachmentId: string, file: AttachmentFile): Promise<Uint8Array> {
    const bytes = await this.store.read(sessionId, attachmentId, file);
    if (bytes === undefined) {
      throw new SessionAttachmentCopyError(
        'not_found',
        `source attachment ${file === 'original' ? 'original' : 'manifest.json'} was not found`,
      );
    }
    return bytes;
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

  private parseManifest(bytes: Uint8Array, attachmentId: string): TransferStoredManifest {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bytes));
    } catch {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment manifest is not valid JSON');
    }
    // The raw source manifest is copied verbatim, so it is parsed by the one parser the store reads it
    // with — durable keys only, so an unplanned field cannot cross into the target unseen.
    try {
      return this.store.parseManifest(parsed, attachmentId);
    } catch {
      throw new SessionAttachmentCopyError('corrupt', 'source attachment manifest is invalid');
    }
  }

  private plannedManifest(stored: TransferStoredManifest): PlannedAttachment {
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
   * A proved manifest beside an unproved original is rebuilt from the source as a whole: nothing is
   * written on a failed proof, and the caller republishes both artifacts.
   */
  private targetProofs(
    sessionId: string,
    expected: PlannedAttachment,
  ): { readonly manifest: PublishableArtifact; readonly original: PublishableArtifact } {
    const artifact = (file: AttachmentFile, proves: (bytes: Uint8Array) => boolean): PublishableArtifact => ({
      read: async () => await this.store.read(sessionId, expected.id, file),
      write: async bytes => await this.store.write(sessionId, expected.id, file, bytes),
      proves,
    });
    return {
      manifest: artifact('manifest', (bytes: Uint8Array): boolean => {
        let stored: TransferStoredManifest;
        try {
          stored = this.parseManifest(bytes, expected.id);
        } catch {
          // parseManifest only ever refuses with a 'corrupt' SessionAttachmentCopyError; a torn or
          // malformed target is recoverable because source verification replaces it atomically.
          return false;
        }
        return sameManifest(this.plannedManifest(stored), expected);
      }),
      original: artifact(
        'original',
        (bytes: Uint8Array): boolean => bytes.byteLength === expected.size && hash(bytes) === expected.sha256,
      ),
    };
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
