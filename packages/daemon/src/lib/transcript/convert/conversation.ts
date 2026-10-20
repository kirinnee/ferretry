import type { TranscriptHarness } from '../types.ts';

/**
 * The harness-neutral conversation a cross-harness conversion passes through.
 *
 * WHY AN INTERMEDIATE FORM AT ALL. A Claude Code transcript and a Codex rollout record the same
 * conversation in shapes that share almost nothing: Claude writes one record per content block and
 * links them by `parentUuid`; Codex writes Responses API items with event mirrors beside them. A
 * direct Claude→Codex mapping and a direct Codex→Claude mapping would each have to know both formats
 * at once. Reading into this form and writing out of it means each reader knows one format, each
 * writer knows one format, and the policy in between — what is kept, what becomes text, what is
 * dropped, how much fits — is written once.
 *
 * WHAT THIS FORM CAN HOLD is deliberately less than either harness records: the person's words, the
 * agent's words, and tool activity. Reasoning cannot cross (Claude's thinking is signed by Anthropic
 * and Codex's is encrypted by OpenAI; neither provider accepts the other's), subagent sidechains are
 * another conversation, and the harness's own reminders and Ferretry's delivery plumbing were never
 * said by anybody. The readers count what they drop so the preview can say so.
 */

/** Bumped whenever a reader, the policy or a writer changes what a conversion produces. */
export const CONVERTER_VERSION = 1;

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
interface ConversationUserEntry {
  readonly kind: 'user';
  readonly text: string;
  readonly at?: string;
  readonly attachments: readonly ConversationAttachment[];
}

/** Something the agent said. */
interface ConversationAssistantEntry {
  readonly kind: 'assistant';
  readonly text: string;
  readonly at?: string;
}

/**
 * A shell command the agent ran, with the output it got back.
 *
 * The one tool both harnesses share a native shape for: Claude's `Bash {command}` and Codex's
 * `exec_command {cmd}` mean the same thing on every version this converter is gated to. Only a call
 * whose result was recorded is held here — a native call without its result is a malformed request
 * on both providers — so an unanswered one becomes a {@link ConversationToolEntry} instead.
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

/** A source transcript, read. */
export interface ReadConversation {
  readonly harness: TranscriptHarness;
  /** The harness version that wrote it, when the transcript records one. */
  readonly version?: string;
  /** The harness's own id for the conversation, when the transcript records one. */
  readonly conversationId?: string;
  /** The model the agent last answered with, when recorded. */
  readonly model?: string;
  readonly entries: readonly ConversationEntry[];
  readonly dropped: ConversationDropped;
}

export const NO_DROPS: ConversationDropped = { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 };

/** The product name of each harness, as a person reads it. */
export const HARNESS_LABEL: Readonly<Record<TranscriptHarness, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** The most of one tool result kept when it crosses as text. */
export const TOOL_TEXT_OUTPUT_MAX = 600;
/** The most of one shell result kept when it crosses as a native call. */
export const SHELL_OUTPUT_MAX = 6000;
/** The most of one tool call's arguments kept on its line. */
export const TOOL_INPUT_MAX = 240;

/** `text` cut to `max` characters, saying how much was cut. */
export function truncated(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters truncated]`;
}

/** One line of text: whitespace runs collapsed, cut to `max`. */
export function oneLine(text: string, max: number): string {
  return truncated(text.replace(/\s+/gu, ' ').trim(), max);
}
