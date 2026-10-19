import { join } from 'node:path';
import type { TranscriptProvenance } from '@ferretry/protocol';
import type { DiscoveredConversation } from './conversations.ts';

/**
 * What adopting one conversation decides, as pure functions the composition root applies.
 *
 * A runtime's CLI only resumes a conversation its own home holds. A conversation the owner had
 * before Ferretry lives in their own `~/.claude` / `~/.codex`, so the file is made visible at the
 * same relative path inside the runtime's home. That is a LINK, never a copy: a copy would fork the
 * history into two files that each look like the conversation, and the one Chat reads would stop
 * matching the one the CLI appends to.
 */

export type ConversationLinkOutcome =
  /** The runtime's home now names the file. */
  | { readonly kind: 'linked' }
  /** It already did: the conversation was in the shared history, or adopted before and released. */
  | { readonly kind: 'present' }
  /** A different file already has this conversation's name there. */
  | { readonly kind: 'conflict'; readonly reason: string }
  /** The runtime's home cannot name this file (another disk, no history folder). */
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Makes `source` reachable at `<runtimeHome>/<relativePath>` without copying it and without changing
 * it. The first segment of `relativePath` is the CLI's history folder (`projects`, `sessions`), which
 * must already exist in the runtime's home.
 */
export interface ConversationLinker {
  link(source: string, runtimeHome: string, relativePath: string): Promise<ConversationLinkOutcome>;
}

/** Where the runtime's CLI looks for this conversation. */
export function adoptedConversationFile(runtimeHome: string, conversation: DiscoveredConversation): string {
  return join(runtimeHome, conversation.relativePath);
}

/**
 * The transcript record of an adopted session.
 *
 * `adopted` rather than `minted` or `correlated`: neither proof happened. The id is the CLI's own,
 * read from the file the owner chose, and the file is the one the resume continues.
 */
export function adoptedTranscriptProvenance(
  runtimeHome: string,
  conversation: DiscoveredConversation,
  at: string,
): TranscriptProvenance {
  return {
    v: 1,
    home: runtimeHome,
    harnessSessionId: conversation.id,
    identity: 'adopted',
    file: adoptedConversationFile(runtimeHome, conversation),
    resolvedAt: at,
  };
}

/** Why a link could not be made, in words, from the error code the filesystem gave. */
export function conversationLinkFailure(
  code: string | undefined,
): Extract<ConversationLinkOutcome, { readonly kind: 'unavailable' }> {
  return {
    kind: 'unavailable',
    reason:
      code === 'EXDEV'
        ? 'The conversation is on a different disk from Ferretry, so the runtime cannot share its file.'
        : `The runtime could not reach the conversation file (${code ?? 'unknown error'}).`,
  };
}
