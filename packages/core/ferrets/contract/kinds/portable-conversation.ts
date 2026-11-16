import type { HarnessKey } from '../ids.ts';
import type { ConversionSummary } from '../move.ts';

/**
 * The harness-neutral conversation a cross-harness move passes through (c58-37; today's `ReadConversation`).
 *
 * WHY AN INTERMEDIATE FORM. A Claude Code transcript and a Codex rollout record one conversation in shapes that share
 * almost nothing. Reading into this form and writing out of it means each harness knows ONE format (its own), and the
 * policy in between (what is kept, what becomes text, what is dropped, how much fits) is written once, by the mover.
 * Each harness fills {@link Harness.exportConversation} and {@link Harness.adoptConversation}; core names no harness.
 *
 * WHAT IT CAN HOLD is less than either harness records: what the person said, what the agent said, and tool activity.
 * Reasoning cannot cross (each provider signs or encrypts its own and accepts no other's), a subagent's sidechain is
 * another conversation, and a harness's own reminders were never said by anybody. A reader counts what it drops
 * ({@link ConversationDropped}) so the preview can say so.
 */

/** A file the person attached, carried as a reference the target agent can open. */
export interface ConversationAttachment {
  readonly kind: 'image' | 'document' | 'file' | 'audio';
  readonly name?: string;
  readonly mediaType?: string;
  /** Where the source recorded it lives, when it recorded a location rather than the bytes. */
  readonly uri?: string;
  /** Base64 bytes, when the source embedded the file itself. */
  readonly data?: string;
}

/** Something the person said. */
export interface ConversationUserEntry {
  readonly kind: 'user';
  readonly text: string;
  readonly at?: string;
  readonly attachments: readonly ConversationAttachment[];
}

/** Something the agent said. */
export interface ConversationAssistantEntry {
  readonly kind: 'assistant';
  readonly text: string;
  readonly at?: string;
}

/**
 * A shell command the agent ran, with the output it got back: the one tool both harnesses share a native shape for. Only a
 * call whose result was recorded is held here (a native call without its result is a malformed request on both
 * providers), so an unanswered one is a {@link ConversationToolEntry}.
 */
export interface ConversationShellEntry {
  readonly kind: 'shell';
  readonly command: string;
  readonly workdir?: string;
  readonly output: string;
  readonly failed: boolean;
  readonly at?: string;
}

/** Any other tool activity, which crosses as a compact line of text inside an agent turn. */
export interface ConversationToolEntry {
  readonly kind: 'tool';
  readonly name: string;
  /** The call's arguments, condensed to one line. */
  readonly input: string;
  /** The result, when one was recorded. */
  readonly output?: string;
  readonly failed: boolean;
  readonly at?: string;
}

export type ConversationEntry =
  | ConversationUserEntry
  | ConversationAssistantEntry
  | ConversationShellEntry
  | ConversationToolEntry;

/** What a reader dropped rather than carried, counted so the preview can say what did not cross. */
export interface ConversationDropped {
  /** Thinking or reasoning blocks. */
  readonly reasoning: number;
  /** Records from a subagent's own conversation (Claude sidechains). */
  readonly sidechains: number;
  /** Harness-internal records: reminders, meta records, developer messages, delivery plumbing. */
  readonly internal: number;
  /** Earlier history the source harness had already compacted away. */
  readonly compactions: number;
}

/** One conversation, read from its source harness: values-free of credentials, bounded by the caller's token budget. */
export interface PortableConversation {
  /** The harness that wrote it, as Ferrets keys it. */
  readonly harness: HarnessKey;
  /** The harness version that wrote it, when the transcript records one. */
  readonly version?: string;
  /** The harness's own id for the conversation, when the transcript records one. */
  readonly conversationId?: string;
  /** The model the agent last answered with, when recorded. */
  readonly model?: string;
  readonly entries: readonly ConversationEntry[];
  readonly dropped: ConversationDropped;
}

/**
 * What a target harness made of a {@link PortableConversation} (`Harness.adoptConversation`): the id its own CLI resumes
 * the conversation by, and the converter's account of what crossed (the same summary the preview shows). On a dry run
 * nothing was written and `conversation` is absent.
 */
export interface AdoptedConversation {
  readonly conversation?: string;
  readonly summary: ConversionSummary;
}
