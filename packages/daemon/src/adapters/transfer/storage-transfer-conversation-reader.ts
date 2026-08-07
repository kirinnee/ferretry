/**
 * The conversation cut, made against ONE exact transcript file — at preparation and again at import.
 *
 * Implements both halves of the seam's read-only conversation contract:
 * `TransferConversationReader` (preparation) and `TransferConversationValidator` (the import
 * preflight). They are one adapter because they must make the SAME cut with the SAME parser: two
 * implementations would eventually disagree, and the whole point of the import re-read is that it
 * can only refuse a plan a preparation already made.
 *
 * THE FILE IS PINNED, NEVER DISCOVERED. `SessionTranscriptReader` is constructed here over a
 * resolver that answers one already-decided path, rather than over the resolving one the live daemon
 * uses. Two different reasons, both mandatory:
 *
 * - Preparation must not write. The discovering resolver correlates a rollout and RECORDS the
 *   attribution back into the session's configuration, which is a write into the source (I1).
 *   Preparation therefore reads the provenance the source already carries and cuts against that
 *   file, so a source with an unresolved transcript yields no conversation and says so, rather than
 *   being altered by the act of being read.
 * - Import must validate the PERSISTED provenance. A plan pins the file its byte offset addresses;
 *   selecting current provenance instead would validate whichever file the source is attributed to
 *   NOW, which is precisely the substitution the re-read exists to catch.
 *
 * Everything below the resolver is the code that already owns these decisions: the one
 * `SessionTranscriptReader`, its journal proof, the harness's own parser, and `digestConversation`.
 * No second parser and no second durable point shape appear here — the exact
 * `{ v: 1, byteOffset, blockIndex }` handed in is the one handed on.
 *
 * `undefined` means "no transcript this daemon can name". An exact-cut preparation refuses that as
 * `conversation_unavailable`, while import refuses it as an unreadable persisted cut. A transcript
 * that EXISTS and cannot honestly yield the requested prefix throws `ConversationDigestError`
 * instead, and the two answers stay distinct all the way to the caller.
 */

import type { ConversationMessagePoint, Harness } from '@ferretry/protocol';
import type { ConversationDigest } from '../../lib/session/transcript/digest.ts';
import { SessionTranscriptReader } from '../../lib/session/transcript/reader.ts';
import type { TranscriptDigestJournal } from '../../lib/session/transcript/reader.ts';
import type { TranscriptSource } from '../../lib/transcript/types.ts';
import type {
  TransferConversationReadInput,
  TransferConversationReader,
  TransferConversationValidationInput,
  TransferConversationValidator,
} from '../../lib/transfer/types.ts';

export class StorageTransferConversationReader implements TransferConversationReader, TransferConversationValidator {
  constructor(
    private readonly sources: readonly TranscriptSource[],
    private readonly journal: TranscriptDigestJournal,
  ) {}

  /**
   * Preparation's cut: the harness and transcript file come from the source snapshot preparation
   * already read, so a later configuration change cannot substitute a different conversation.
   */
  async digest(input: TransferConversationReadInput): Promise<ConversationDigest | undefined> {
    const file = input.transcriptProvenance.file;
    if (file === undefined) return undefined;
    return await this.digestFile(file, input.sourceSessionId, input.sourceHarness, input.through);
  }

  /**
   * Import's re-read: the harness and the file come from the PLAN, never from the source's current
   * configuration, so a source re-attributed to a different transcript cannot answer for this one.
   */
  async digestPinned(input: TransferConversationValidationInput): Promise<ConversationDigest | undefined> {
    const file = input.transcriptProvenance.file;
    if (file === undefined) return undefined;
    return await this.digestFile(file, input.sourceSessionId, input.sourceHarness, input.through);
  }

  private async digestFile(
    file: string,
    sessionId: string,
    harness: Harness,
    through: ConversationMessagePoint,
  ): Promise<ConversationDigest | undefined> {
    const reader = new SessionTranscriptReader(this.sources, { file: async () => file }, this.journal);
    return await reader.digest({ sessionId, harness }, through);
  }
}
