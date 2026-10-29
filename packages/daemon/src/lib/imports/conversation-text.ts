import { isAbsolute, normalize, sep } from 'node:path';
import {
  CONVERSATION_EXCHANGE_COUNT,
  CONVERSATION_EXCHANGE_TEXT_MAX,
  type ConversationExchangeMessage,
} from '@ferretry/protocol/conversation-import';
import { parseHandoffPointer, parseMessageAttachments, readHandoffDocument } from '@ferretry/protocol/turn-handoff';
import { isOwnerMessage } from '../transcript/owner.ts';
import type { TranscriptEvent } from '../transcript/types.ts';

/**
 * What the OWNER said in a conversation, read back out of a transcript that also records how it was
 * delivered.
 *
 * A message a ferret or a kteam teammate was given usually reached the CLI as one pointer line ("Read
 * the file …/turns/turn-001.md now, then carefully follow every instruction inside it…"), so the
 * transcript's first user message is that line, and a listing of conversations read as a column of
 * identical pointers. The pointer's document holds the real message; when it cannot be read, the
 * pointer says nothing about the conversation and the next real message describes it instead. The
 * other wrappers a harness or a delivery adds — reminders, an attachment list, the CLI's own tagged
 * blocks — are dropped the same way.
 *
 * Everything here is pure: the documents a pointer names are read by the caller, through the read-only
 * file port and only inside the folders it allows, and handed in as {@link HandoffDocuments}.
 */

/** The most of one hand-off document that is ever read. A message is short; a document is not trusted. */
export const HANDOFF_READ_MAX_BYTES = 64 * 1024;

/** Hand-off documents already read, by the path the pointer named. A missing path was not readable. */
export type HandoffDocuments = ReadonlyMap<string, string>;

const NO_DOCUMENTS: HandoffDocuments = new Map();

/** kteam's turn-one document: a contract first, then the task under this heading. */
const ASSIGNED_TASK_MARKER = '\n# Assigned task\n\n';

/** A harness's reminder blocks, which ride inside a user record but were never typed. */
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;

/**
 * What a CLI writes AS the user before or around what was typed, each block whole:
 *
 *   Codex        the folder's AGENTS.md, as `# AGENTS.md instructions for <folder>` over an `<INSTRUCTIONS>`
 *                block, and its `<environment_context>`, `<user_instructions>`, `<user_environment>`,
 *                `<turn_aborted>` and `<user_shell_command>` blocks
 *   Claude Code  a slash command's `<command-name>`, `<command-message>` and `<command-args>`, and the
 *                `<local-command-*>` caveat and output around it
 *
 * A block is dropped only when it is closed, so a person who types one of these tags keeps their words.
 */
const AGENTS_FILE_BLOCK = /^# AGENTS\.md instructions for [^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gmu;
const INJECTED_BLOCK =
  /<(environment_context|user_instructions|user_environment|turn_aborted|user_shell_command|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/gu;

/** Whole messages a CLI writes as the user that say nothing about the conversation. */
const NOISE = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The path a whole-message hand-off pointer names, or `undefined` when the text is anything else. */
export function handoffPointerPath(text: string): string | undefined {
  return parseHandoffPointer(text)?.path;
}

/** Where a hand-off pointer's document may be read from. Anything else is treated as unreadable. */
export interface HandoffScope {
  /** Folders any document inside which may be read: where Ferretry keeps each session's own folder. */
  readonly roots: readonly string[];
  /**
   * Homes whose hidden folders may hold another agent coordinator's per-agent turn files, read only
   * at exactly `<home>/.<coordinator>/<agent>/turns/turn-NNN.md` — the layout such a coordinator
   * writes its pointers with — and never anything else under the home.
   */
  readonly coordinatorHomes: readonly string[];
}

export const NO_HANDOFF_SCOPE: HandoffScope = { roots: [], coordinatorHomes: [] };

/** `.<coordinator>/<agent>/turns/turn-NNN.md`, relative to a coordinator home. */
const COORDINATOR_TURN = /^\.[^\\/]+[\\/][^\\/]+[\\/]turns[\\/]turn-\d{1,9}\.md$/u;

const below = (path: string, folder: string): string | undefined => {
  const base = normalize(folder).replace(/[\\/]+$/u, '');
  return base !== '' && path.startsWith(`${base}${sep}`) ? path.slice(base.length + 1) : undefined;
};

/**
 * Whether `path` may be read as a hand-off document under `scope`. A relative path, or one that
 * normalising would move (a `..`, a doubled separator), never may: the pointer is the agent's
 * transcript, and the agent does not get to choose what the daemon reads.
 */
export function isReadableHandoff(path: string, scope: HandoffScope): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  if (scope.roots.some(root => below(path, root) !== undefined)) return true;
  return scope.coordinatorHomes.some(home => COORDINATOR_TURN.test(below(path, home) ?? ''));
}

/** The message a hand-off document carries: the task under kteam's contract, else the document as written. */
export function handoffDocumentMessage(document: string): string {
  const task = document.indexOf(ASSIGNED_TASK_MARKER);
  const body = task === -1 ? document : document.slice(task + ASSIGNED_TASK_MARKER.length);
  return readHandoffDocument(body).message;
}

/** A user message without the reminders and the blocks a harness injected, keeping a delivery's attachment list. */
export function withoutHarnessBlocks(text: string): string {
  return text.replace(REMINDER_BLOCK, '').replace(AGENTS_FILE_BLOCK, '').replace(INJECTED_BLOCK, '').trim();
}

/** A user message without the reminders, the injected blocks and the attachment list a harness or a delivery wrapped it in. */
export function withoutDeliveryWrappers(text: string): string {
  return parseMessageAttachments(withoutHarnessBlocks(text)).message;
}

/**
 * What the owner actually said in one user message, whitespace-collapsed, or `undefined` when it says
 * nothing about the conversation: a pointer whose document was not read, a CLI's own tagged block
 * (`<command-name>`, `<environment_context>`, `<user_instructions>` all open with a tag), an
 * interruption marker, or nothing at all.
 */
export function spokenText(text: string, documents: HandoffDocuments = NO_DOCUMENTS): string | undefined {
  const pointer = handoffPointerPath(text);
  let message = text;
  if (pointer !== undefined) {
    const document = documents.get(pointer);
    if (document === undefined) return undefined;
    message = handoffDocumentMessage(document);
  }
  const spoken = collapse(withoutDeliveryWrappers(message));
  return spoken === '' || spoken.startsWith('<') || NOISE.has(spoken) ? undefined : spoken;
}

/** The words of `text` a title is compared on: lower-case, letters and digits, a plural's `s` dropped. */
export function titleWords(text: string): readonly string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(word => {
    if (word.length < 3 && !/\p{N}/u.test(word)) return [];
    return [word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word];
  });
}

/**
 * The words only the WRAPPERS of a conversation used: every owner message as it was recorded (a pointer
 * and its path, an AGENTS.md block, a reminder) and each hand-off document's preamble, less every word
 * the owner actually said. Empty when nothing was wrapped, so a plain conversation never loses a title.
 */
export function wrapperOnlyWords(
  events: readonly TranscriptEvent[],
  documents: HandoffDocuments = NO_DOCUMENTS,
): ReadonlySet<string> {
  const recorded = new Set<string>();
  const spoken = new Set<string>();
  for (const event of events) {
    if (!isOwnerMessage(event)) continue;
    const said = spokenText(event.text, documents);
    for (const word of titleWords(said ?? '')) spoken.add(word);
    if (said !== undefined && said === collapse(event.text)) continue;
    for (const word of titleWords(event.text)) recorded.add(word);
    const document = documents.get(handoffPointerPath(event.text) ?? '');
    const task = document?.indexOf(ASSIGNED_TASK_MARKER) ?? -1;
    if (document !== undefined && task > 0) for (const word of titleWords(document.slice(0, task))) recorded.add(word);
  }
  return new Set([...recorded].filter(word => !spoken.has(word)));
}

/**
 * Whether a GENERATED title describes the wrapper it was generated from rather than the conversation:
 * most of its words are ones only the wrappers used ("Ferretry session turn-001 file", "Turn-001.md
 * instructions" — a CLI titled the pointer line it was given). A word list alone would also drop a
 * person's own "turn instructions" conversation; matching the wrapper actually recorded does not.
 */
export function isWrapperTitle(title: string, wrapperWords: ReadonlySet<string>): boolean {
  const words = titleWords(title);
  const borrowed = words.filter(word => wrapperWords.has(word)).length;
  return borrowed > 0 && borrowed * 2 > words.length;
}

/** Every path a user message of `events` points at, so the caller can read those documents first. */
export function handoffPointers(events: readonly TranscriptEvent[]): readonly string[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'message' || event.role !== 'user') continue;
    const path = handoffPointerPath(event.text);
    if (path !== undefined) paths.add(path);
  }
  return [...paths];
}

/** What the owner said, in order, one entry per user message that said something. */
export function spokenMessages(
  events: readonly TranscriptEvent[],
  documents: HandoffDocuments = NO_DOCUMENTS,
): readonly string[] {
  return events.flatMap(event => {
    if (!isOwnerMessage(event)) return [];
    const spoken = spokenText(event.text, documents);
    return spoken === undefined ? [] : [spoken];
  });
}

/** `text` cut to `max` characters, the cut marked. */
export const truncateText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * The last `count` exchanges, oldest first: each owner message, then the reply that ended its turn
 * (the last assistant message before the next owner message — a turn's earlier messages are narration).
 * Every message is whitespace-collapsed and cut to the preview length.
 */
export function recentExchanges(
  events: readonly TranscriptEvent[],
  documents: HandoffDocuments = NO_DOCUMENTS,
  count: number = CONVERSATION_EXCHANGE_COUNT,
): readonly ConversationExchangeMessage[] {
  const messages: ConversationExchangeMessage[] = [];
  for (const event of events) {
    if (event.kind !== 'message' || event.inputSource === 'harness') continue;
    if (event.role === 'user') {
      const spoken = spokenText(event.text, documents);
      if (spoken !== undefined) messages.push({ role: 'user', text: spoken });
      continue;
    }
    if (event.role !== 'assistant') continue;
    const reply = collapse(event.text);
    if (reply === '') continue;
    if (messages.at(-1)?.role === 'assistant') messages.pop();
    messages.push({ role: 'assistant', text: reply });
  }
  const starts = messages.flatMap((message, index) => (message.role === 'user' ? [index] : []));
  const from = count <= 0 ? messages.length : (starts.at(-count) ?? 0);
  return messages
    .slice(from)
    .map(message => ({ role: message.role, text: truncateText(message.text, CONVERSATION_EXCHANGE_TEXT_MAX) }));
}
