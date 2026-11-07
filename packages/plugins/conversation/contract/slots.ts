/**
 * THE SLOTS CONVERSATION'S CHAT OFFERS (§5.2; lead decisions Q3/Q4). A plugin contributes a panel to one with
 * `panel(CONVERSATION_ROW_SLOT, { id })`; the chat mounts every panel contributed there once per transcript row, with
 * the row's entry in its props and the ferret as its `subject`. Conversation imports nothing of a contributor.
 *
 *   - `conversation.row` ........ beside a row of the transcript; the panel sees only {id, kind, text, at?, label?, tools?}; `tools`
 *                                 are a tool row's shell commands and their text answers, never another tool's input.
 *   - `conversation.row-actions`  in an assistant message's footer: Voice offers "Read aloud" on the message.
 */

export const CONVERSATION_ROW_SLOT = 'conversation.row' as const;
export const CONVERSATION_ROW_ACTIONS_SLOT = 'conversation.row-actions' as const;

/** Every slot the chat offers, in one list a test can pair against the panels other plugins contribute. */
export const CONVERSATION_SLOTS = [CONVERSATION_ROW_SLOT, CONVERSATION_ROW_ACTIONS_SLOT] as const;
export type ConversationSlot = (typeof CONVERSATION_SLOTS)[number];

/**
 * The transcript row a panel is drawn for, as far as a contributor may rely on it. The chat hands ONLY these fields (the
 * rest of its row stays inside Conversation), built from the daemon's reading of this ferret's transcript: the words are
 * the daemon's redacted text, so a value Vault masks is masked here too. A row that exists only on this device (a send
 * that has not landed, or was refused) has not been through the daemon, so it is never offered to a slot.
 */
export interface ConversationRowEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'notice' | 'system';
  readonly text: string;
  /** Epoch milliseconds of the row's first record, when known. */
  readonly at?: number;
  readonly label?: string;
  /**
   * A `tool` row's SHELL commands and what they printed, for a contributor that reads a ferret's own commands (Packs draws
   * the helpers a ferret started). Only a call to a shell tool (Bash, exec_command, shell, local_shell) is offered, and only
   * the command and the text of its answer: no other tool's input, no image, no attachment. Built from the daemon's
   * redacted reading like `text`, so a value Vault masks is masked here too. Absent on every other row, and on a row that
   * is a send a ferret made.
   */
  readonly tools?: readonly ConversationRowToolCall[];
}

/** One shell command a `tool` row ran, as far as a contributor may rely on it. */
export interface ConversationRowToolCall {
  /** Stable for the call across re-reads. */
  readonly key: string;
  /** The tool's name as the harness calls it (`Bash`, `exec_command`, `shell`, `local_shell`). */
  readonly name: string;
  /** The command line, or the script a shell was handed. */
  readonly command: string;
  /** ISO instant the call started, when known. */
  readonly ts?: string;
  /** What came back, once it has: the answer's text (cut at {@link ROW_TOOL_TEXT_LIMIT} characters) and whether it failed. */
  readonly result?: { readonly text: string; readonly isError?: boolean };
}

/** The most characters of a command's answer a slot is handed; a longer answer is cut. */
export const ROW_TOOL_TEXT_LIMIT = 100_000;

/** The props every panel in a Conversation slot receives, beside its `subject` (the ferret). */
export interface ConversationRowProps {
  readonly entry: ConversationRowEntry;
}
