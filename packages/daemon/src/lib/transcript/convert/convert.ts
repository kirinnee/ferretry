import type { HandoffDocuments } from '../../imports/conversation-text.ts';
import type { TranscriptHarness } from '../types.ts';
import { boundHistory, historyBudget } from './bound.ts';
import {
  CONVERTER_VERSION,
  type ConversationAttachment,
  type ConversationDropped,
  type ConversationEntry,
  HARNESS_LABEL,
  oneLine,
  type ReadConversation,
  TOOL_INPUT_MAX,
  TOOL_TEXT_OUTPUT_MAX,
  truncated,
} from './conversation.ts';
import { readClaudeConversation } from './read-claude.ts';
import { readCodexConversation } from './read-codex.ts';
import { exitCodeOf, type RenderableEntry, toolLine } from './render.ts';
import {
  classifyRolloutShape,
  type RolloutFormatVerdict,
  rolloutShape,
  REQUIRED_ROLLOUT_KINDS,
} from './rollout-format.ts';
import { harnessVersionGate, parseHarnessVersion } from './versions.ts';
import { CLAUDE_SHELL_TOOL, writeClaudeTranscript } from './write-claude.ts';
import { CODEX_SHELL_TOOL, writeCodexRollout } from './write-codex.ts';

/**
 * Converting one conversation from Claude Code to Codex or back, without a model in the loop.
 *
 * Pure: the caller reads the source transcript and the hand-off documents it points at, says which
 * versions are on each side and how big the target window is, and gets back the target file's text,
 * the attachment files to write beside it, and an account of what crossed. Writing those, proving the
 * target CLI accepts them, and switching the session over are the caller's — see
 * `docs/migration-cross-harness.md`.
 */

export interface ConversionSource {
  readonly harness: TranscriptHarness;
  /** The source transcript, whole. */
  readonly text: string;
  /** Hand-off documents its pointers name, already read. A missing one keeps its pointer. */
  readonly documents: HandoffDocuments;
}

export interface ConversionTarget {
  readonly harness: TranscriptHarness;
  /** The target CLI's `--version` banner, or `undefined` when it could not be read. */
  readonly version: string | undefined;
  /** The fresh id the target conversation is written under. */
  readonly conversationId: string;
  readonly cwd: string;
  /** The target model's context window, in tokens. */
  readonly contextWindow: number;
  /**
   * The model the target will run. Claude records it on every assistant message and, on resume, tries
   * to restore it — a Codex model name there makes it announce that it fell back to its default.
   */
  readonly model?: string;
  /** Codex only: extra workspace roots its `session_meta` records. */
  readonly workspaceRoots?: readonly string[];
  /** Codex only: the model provider the target login runs. Codex's own default when absent. */
  readonly modelProvider?: string;
  /**
   * Whether shell commands cross as the target's own shell tool calls (the default) or as text like
   * every other tool. Text is the fallback for a target CLI that does not declare its shell tool for
   * the model the runtime will run — a native call to an undeclared tool is a request its provider
   * may reject outright.
   */
  readonly nativeShell?: boolean;
  /**
   * Codex only: what a probe of the installed binary found about the rollouts it writes. Asked about
   * only when `version` is outside the measured table (see `versions.ts`); without it such a version is refused.
   */
  readonly format?: RolloutFormatVerdict;
}

export interface ConversionRequest {
  readonly source: ConversionSource;
  readonly target: ConversionTarget;
  /** Where an embedded attachment is saved for the target agent to open, absolute. */
  readonly attachmentDirectory: string;
  /** Now, for an entry the source left undated and for the new thread's creation time. */
  readonly at: string;
}

/** A file the conversion needs written before the target conversation is resumed. */
export interface ConvertedFile {
  /** The file's name inside the request's `attachmentDirectory`. */
  readonly name: string;
  /** Base64 bytes. */
  readonly data: string;
}

/** What crossed, what became text and what did not cross — the preview a person confirms. */
export interface ConversionSummary {
  readonly converter: number;
  readonly source: {
    readonly harness: TranscriptHarness;
    readonly version?: string;
    readonly conversationId?: string;
  };
  readonly target: { readonly harness: TranscriptHarness; readonly version: string; readonly conversationId: string };
  readonly turns: number;
  readonly keptTurns: number;
  readonly omittedTurns: number;
  /** Whether the newest turn itself was cut to fit. */
  readonly cutNewest: boolean;
  /** Messages carried as messages (the person's and the agent's). */
  readonly messages: number;
  /** Shell commands carried as native calls with their output. */
  readonly nativeToolCalls: number;
  /** Other tool calls, carried as text lines inside the agent's turns. */
  readonly toolCallsAsText: number;
  /** Attachments carried as references. */
  readonly attachments: number;
  readonly dropped: ConversationDropped;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  /** Set when a Codex version outside the tested table was let through because its format is the validated one. */
  readonly formatNote?: string;
}

export interface Converted {
  readonly kind: 'converted';
  /** The target transcript's whole text. */
  readonly transcript: string;
  readonly files: readonly ConvertedFile[];
  readonly summary: ConversionSummary;
  /**
   * Texts the target CLI must send to its model, in this order, when it resumes the conversation —
   * the proof a validation run checks that the history was read rather than merely tolerated.
   */
  readonly sentinels: readonly string[];
  /** The native tool names the history uses, which the target CLI must declare. */
  readonly nativeTools: readonly string[];
}

export interface ConversionRefused {
  readonly kind: 'refused';
  readonly reason: string;
}

export type ConversionResult = Converted | ConversionRefused;

/** The provider Codex runs when its configuration names none. */
const CODEX_DEFAULT_PROVIDER = 'openai';

/** How the target is told the history was carried, and from where. */
export const CONVERSION_NOTICE_HEAD = '[Ferretry moved this conversation here from';

function notice(read: ReadConversation, target: TranscriptHarness, omitted: number, nativeShell: boolean): string {
  const from = HARNESS_LABEL[read.harness];
  const id = read.conversationId === undefined ? '' : ` (conversation ${read.conversationId})`;
  const tools = nativeShell
    ? `Shell commands carried over as ${HARNESS_LABEL[target]} commands; other tool activity from ${from} is shown as text`
    : `Tool activity from ${from} is shown as text`;
  const lines = [
    `${CONVERSION_NOTICE_HEAD} ${from}${id}. ${tools}, and those tools may not exist here. ` +
      `Its thinking and any subagent work were not carried.]`,
  ];
  if (omitted > 0) lines.push(`[earlier history omitted: ${omitted} ${omitted === 1 ? 'turn' : 'turns'}]`);
  return lines.join('\n');
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** A safe file name for an attachment: its own name's characters where they are safe, never a path. */
function attachmentName(attachment: ConversationAttachment, index: number): string {
  const extension = EXTENSIONS[attachment.mediaType ?? ''] ?? 'bin';
  const stem = (attachment.name ?? '')
    .replace(/\.[^.]*$/u, '')
    .replaceAll(/[^\w-]/gu, '_')
    .slice(0, 40);
  return `attachment-${index}${stem === '' ? '' : `-${stem}`}.${extension}`;
}

/** The user entries with their attachments turned into reference lines, and the files those name. */
function referencedAttachments(
  entries: readonly ConversationEntry[],
  directory: string,
): { readonly entries: readonly RenderableEntry[]; readonly files: readonly ConvertedFile[]; readonly count: number } {
  const files: ConvertedFile[] = [];
  let count = 0;
  const rendered = entries.map((entry): RenderableEntry => {
    if (entry.kind !== 'user') return entry;
    const lines = entry.attachments.map(attachment => {
      count += 1;
      const label = `${attachment.kind}${attachment.name === undefined ? '' : ` ${attachment.name}`}`;
      if (attachment.data !== undefined) {
        const name = attachmentName(attachment, count);
        files.push({ name, data: attachment.data });
        return `[${label} attached — saved at ${directory}/${name}]`;
      }
      if (attachment.uri !== undefined) return `[${label} attached: ${attachment.uri}]`;
      return `[${label} attached — not carried]`;
    });
    const text = [entry.text, ...lines].filter(part => part !== '').join('\n');
    return { kind: 'user', text, ...(entry.at === undefined ? {} : { at: entry.at }) };
  });
  return { entries: rendered, files, count };
}

/** The opening user message carries the notice: prefixed to the first one, or standing alone before it. */
function withNotice(entries: readonly RenderableEntry[], text: string, at: string): readonly RenderableEntry[] {
  const [first, ...rest] = entries;
  if (first?.kind === 'user') return [{ ...first, text: `${text}\n\n${first.text}` }, ...rest];
  return [{ kind: 'user', text, at: first?.at ?? at }, ...entries];
}

/** A shell command as a text tool line, for a target that will not take it natively. */
function asText(entry: ConversationEntry): ConversationEntry {
  if (entry.kind !== 'shell') return entry;
  return {
    kind: 'tool',
    name: 'shell',
    input: oneLine(entry.command, TOOL_INPUT_MAX),
    output: truncated(entry.output.trim(), TOOL_TEXT_OUTPUT_MAX),
    failed: entry.failed,
    ...(entry.at === undefined ? {} : { at: entry.at }),
  };
}

/**
 * What the validation run must find, in order, in the history the target CLI sends: the opening of
 * every carried message, every text tool line and every shell result. Each is a short slice, so a CLI
 * that re-wraps a long message still matches, while one that drops or reorders any turn does not.
 */
function sentinelsOf(entries: readonly RenderableEntry[]): readonly string[] {
  return entries.flatMap(entry => {
    const text =
      entry.kind === 'user' || entry.kind === 'assistant'
        ? entry.text
        : entry.kind === 'tool'
          ? toolLine(entry)
          : exitCodeOf(entry.output).rest;
    const slice = text.trim().split('\n')[0]?.slice(0, 80) ?? '';
    return slice === '' ? [] : [slice];
  });
}

function read(source: ConversionSource): ReadConversation {
  return source.harness === 'claude'
    ? readClaudeConversation(source.text, source.documents)
    : readCodexConversation(source.text, source.documents);
}

export function convertConversation(request: ConversionRequest): ConversionResult {
  const { source, target } = request;
  if (source.harness === target.harness)
    return {
      kind: 'refused',
      reason: `This conversation is already ${HARNESS_LABEL[target.harness]}'s; it needs no conversion to resume there.`,
    };
  const conversation = read(source);
  // A rollout's own text says what shape its version wrote, so the source side needs no probe.
  const sourceGate = harnessVersionGate(source.harness, conversation.version, 'source', () =>
    classifyRolloutShape(rolloutShape(source.text), REQUIRED_ROLLOUT_KINDS),
  );
  if (sourceGate.kind === 'refused') return { kind: 'refused', reason: sourceGate.reason };
  const targetGate = harnessVersionGate(target.harness, target.version, 'target', () => target.format);
  const parsed = parseHarnessVersion(target.version ?? '');
  if (targetGate.kind === 'refused' || parsed === undefined)
    return { kind: 'refused', reason: targetGate.kind === 'refused' ? targetGate.reason : '' };
  const formatNote = [sourceGate, targetGate].flatMap(gate => (gate.kind === 'by-format' ? [gate.note] : [])).join(' ');
  // The bare number, as the target writes it in its own records — never the banner it was read from.
  const targetVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (conversation.entries.length === 0)
    return {
      kind: 'refused',
      reason: `There's nothing in this ${HARNESS_LABEL[source.harness]} conversation that can be carried over yet.`,
    };

  const bounded = boundHistory(conversation.entries, historyBudget(target.contextWindow));
  if (bounded.entries.length === 0)
    return {
      kind: 'refused',
      reason: `The target model's ${target.contextWindow}-token window leaves no room for any of this conversation.`,
    };
  const nativeShell = target.nativeShell !== false;
  const carried = nativeShell ? bounded.entries : bounded.entries.map(asText);
  const attached = referencedAttachments(carried, request.attachmentDirectory);
  const text = notice(conversation, target.harness, bounded.omittedTurns, nativeShell);
  const entries = withNotice(attached.entries, text, request.at);
  const transcript =
    target.harness === 'claude'
      ? writeClaudeTranscript({
          entries,
          sessionId: target.conversationId,
          cwd: target.cwd,
          version: targetVersion,
          model: target.model ?? conversation.model ?? 'converted',
          at: request.at,
        })
      : writeCodexRollout({
          entries,
          threadId: target.conversationId,
          cwd: target.cwd,
          version: targetVersion,
          at: request.at,
          workspaceRoots: target.workspaceRoots ?? [],
          modelProvider: target.modelProvider ?? CODEX_DEFAULT_PROVIDER,
        });

  const count = (kind: ConversationEntry['kind']): number => carried.filter(entry => entry.kind === kind).length;
  const nativeToolCalls = count('shell');
  return {
    kind: 'converted',
    transcript,
    files: attached.files,
    summary: {
      converter: CONVERTER_VERSION,
      source: {
        harness: source.harness,
        ...(conversation.version === undefined ? {} : { version: conversation.version }),
        ...(conversation.conversationId === undefined ? {} : { conversationId: conversation.conversationId }),
      },
      target: { harness: target.harness, version: targetVersion, conversationId: target.conversationId },
      turns: bounded.turns,
      keptTurns: bounded.keptTurns,
      omittedTurns: bounded.omittedTurns,
      cutNewest: bounded.cutNewest,
      messages: count('user') + count('assistant'),
      nativeToolCalls,
      toolCallsAsText: count('tool'),
      attachments: attached.count,
      dropped: conversation.dropped,
      estimatedTokens: bounded.estimatedTokens,
      budgetTokens: bounded.budgetTokens,
      ...(formatNote === '' ? {} : { formatNote }),
    },
    sentinels: sentinelsOf(entries),
    nativeTools: nativeToolCalls === 0 ? [] : [target.harness === 'claude' ? CLAUDE_SHELL_TOOL : CODEX_SHELL_TOOL],
  };
}
