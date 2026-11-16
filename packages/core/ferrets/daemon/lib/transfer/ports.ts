/**
 * What the transfer seam needs from owners that are NOT Ferrets: the transcript reader and the attachment store.
 *
 * Ferrets (core) may not import a plugin, so each owner is reached through the smallest structural interface the
 * transfer code uses. The bodies that use them are unchanged; what changed is that they take the owner's answer through
 * an injected port instead of constructing the owner's class.
 *
 * UNBOUND until the host binds them (a fail-closed skeleton answers `503`):
 *
 *   - {@link PinnedTranscriptDigests}  owner: Conversation (the transcript reader and its digest primitive)
 *   - {@link TransferAttachmentStore}  owner: Conversation (the attachment store and its manifest parser)
 *   - {@link TransferAttachmentReader} (`./types.ts`) owner: Conversation (the attachment inventory)
 */

import type { AttachmentFacet } from '../../../contract/transfer.ts';
import type { Harness } from '../protocol/session-base.ts';
import type { ConversationMessagePoint } from '../protocol/session-transfer-edge.ts';

// ─── the digest the conversation owner makes ─────────────────────────────────────────────────────────────────────

/** The roles a replacement harness can receive as ordinary conversation context. */
export type ConversationMessageRole = 'user' | 'assistant' | 'developer' | 'system';

export interface ConversationMessage {
  readonly point: ConversationMessagePoint;
  readonly role: ConversationMessageRole;
  readonly text: string;
  readonly timestamp?: string;
}

/** Evidence deliberately omitted because it cannot be replayed across harnesses. */
export interface ConversationDigestOmission {
  readonly point: ConversationMessagePoint;
  /** The transcript event kind that was left behind (anything but a message). */
  readonly kind: string;
  readonly reason: 'harness-specific' | 'unreadable';
}

/**
 * The cut's raw-record evidence: verification input, and nothing a caller may keep.
 *
 * IT IS EPHEMERAL. A contributor strips it before the conversation facet is built: it must never reach a transfer
 * plan, a lineage edge, a fork receipt or any public outcome.
 */
export interface ConversationSelectionEvidence {
  /** The cut coordinate, restated so evidence cannot drift from the point it speaks for. */
  readonly point: ConversationMessagePoint;
  /** `H_i` — 32 bytes — for the physical record the cut was normalized from. */
  readonly rawPrefix: Uint8Array;
}

/** A portable prefix of one conversation, with no harness-shaped fields. */
export interface ConversationDigest {
  readonly sessionId: string;
  readonly through: ConversationMessagePoint;
  readonly messages: readonly ConversationMessage[];
  readonly omissions: readonly ConversationDigestOmission[];
  /**
   * Present exactly when the batch carried its physical record bytes. A caller that needs to BIND something refuses
   * its absence; import's validation-only re-read binds nothing and works without it.
   */
  readonly selectionEvidence?: ConversationSelectionEvidence;
}

export type ConversationDigestFailure = 'incomplete_transcript' | 'target_not_found' | 'target_not_message';

const DIGEST_FAILURES: ReadonlySet<string> = new Set<ConversationDigestFailure>([
  'incomplete_transcript',
  'target_not_found',
  'target_not_message',
]);

/** A transcript cannot honestly become portable context. */
export class ConversationDigestError extends Error {
  constructor(
    readonly failure: ConversationDigestFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationDigestError';
  }
}

/**
 * Whether a thrown value is the digest primitive's refusal.
 *
 * Structural on purpose: the primitive is the conversation owner's class, so a transfer cannot rely on `instanceof`
 * across that boundary. The name and the closed `failure` vocabulary are what the owner's error carries.
 */
export function isConversationDigestError(error: unknown): error is ConversationDigestError {
  return (
    error instanceof Error &&
    error.name === 'ConversationDigestError' &&
    typeof (error as { failure?: unknown }).failure === 'string' &&
    DIGEST_FAILURES.has((error as unknown as { failure: string }).failure)
  );
}

/**
 * Whether two durable coordinates address the same message — VERSION INCLUDED.
 *
 * `v` participates because a coordinate is a versioned durable wire value: a `v: 2` point carrying this offset
 * addresses a message under whatever `v: 2` comes to mean, and answering "same" would let a later version silently
 * re-address an earlier one's evidence.
 */
export function sameConversationMessagePoint(left: ConversationMessagePoint, right: ConversationMessagePoint): boolean {
  return left.v === right.v && left.byteOffset === right.byteOffset && left.blockIndex === right.blockIndex;
}

/**
 * The conversation owner's digest, made against ONE already-decided transcript file.
 *
 * THE FILE IS PINNED, NEVER DISCOVERED: the implementation must not resolve or record an attribution (that is a write
 * into the source), and must answer `undefined` when no transcript can be named. It throws a
 * {@link ConversationDigestError} when a transcript EXISTS and cannot honestly yield the requested prefix.
 */
export interface PinnedTranscriptDigests {
  digest(
    target: { readonly sessionId: string; readonly harness: Harness },
    file: string,
    through: ConversationMessagePoint,
  ): Promise<ConversationDigest | undefined>;
}

// ─── attachments ─────────────────────────────────────────────────────────────────────────────────────────────────

type PlannedAttachment = AttachmentFacet['attachments'][number];

/**
 * One attachment as the inventory reports it: only what a plan pins.
 *
 * `encrypted` is read for presence alone — the plan always records a locked encrypted original, never an unlock.
 */
export type TransferAttachmentView = Pick<
  PlannedAttachment,
  'id' | 'filename' | 'mime' | 'size' | 'sha256' | 'createdAt'
> & { readonly encrypted?: unknown };

/** One attachment's durable manifest, exactly as `manifest.json` holds it beside its `original`. */
export interface TransferStoredManifest {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: PlannedAttachment['createdAt'];
  readonly encrypted?: { readonly kind: 'pdf' };
}

/** Which of an attachment's two durable files. */
export type AttachmentFile = 'original' | 'manifest';

/**
 * The attachment tree the owner keeps, reached by session and content address.
 *
 * The ids handed in are already validated, so an implementation may use them as path segments.
 *
 *   - `read` answers the stored bytes, or `undefined` when that file is not there. It never decrypts and never
 *     restamps: the source is read-only.
 *   - `write` replaces that one file ATOMICALLY AND DURABLY: when it resolves, the bytes are on the medium under their
 *     final name. The durability contract the transfer rests on (`./adapters/transfer/durable-artifact.ts`) is built
 *     on this being true.
 *   - `parseManifest` is the owner's ONE parser of a stored manifest (durable keys only, content-addressed id, usable
 *     filename). It throws on anything it does not accept.
 */
export interface TransferAttachmentStore {
  read(sessionId: string, attachmentId: string, file: AttachmentFile): Promise<Uint8Array | undefined>;
  write(sessionId: string, attachmentId: string, file: AttachmentFile, bytes: Uint8Array): Promise<void>;
  parseManifest(document: unknown, attachmentId: string): TransferStoredManifest;
}
