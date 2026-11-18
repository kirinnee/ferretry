/**
 * THE SLOTS CONVERSATION'S CHAT OFFERS (§5.2; lead decisions Q3/Q4). A plugin contributes a panel to one with
 * `panel(CONVERSATION_ROW_SLOT, { id })`; the chat mounts every panel contributed there once per transcript row, with
 * the row's entry in its props and the ferret as its `subject`. Conversation imports nothing of a contributor.
 *
 *   - `conversation.row` ........ beside a row of the transcript; the panel sees only {id, kind, text, at?, label?, tools?}; `tools`
 *                                 are a tool row's shell calls whose WHOLE script is one plain command of a program named `fy`
 *                                 (no pipe, list, redirect, subshell or expansion), and their text answers; never another script or tool.
 *   - `conversation.row-body` ... INSTEAD of the words of the person's own message (a `user` row, or a send still on its
 *                                 way): Agenda draws an agenda message as its card. The panel gets {entry, onItsWay?, fallback}
 *                                 and returns `fallback` (the plain words) when it does not recognise the message.
 *   - `conversation.row-actions`  in an assistant message's footer: Voice offers "Read aloud" on the message.
 *   - `conversation.above-composer` directly above the composer: Claude Code's permission and harness-dialog cards, and
 *                                 Voice's auto-read chip (it sees the rows, the turn, what the ferret waits on and the send ledger).
 */

export const CONVERSATION_ROW_SLOT = 'conversation.row' as const;
export const CONVERSATION_ROW_ACTIONS_SLOT = 'conversation.row-actions' as const;
/**
 * Where a message's words are drawn INSTEAD of the chat's plain prose: the panels contributed here are nested in layout
 * order and each gets {@link ConversationRowBodyProps}; no panel, or one that cannot be drawn or throws, leaves the
 * plain words. Not a place BESIDE a row (that is `conversation.row`): a card here stands in for the words, so it does
 * not repeat them.
 */
export const CONVERSATION_ROW_BODY_SLOT = 'conversation.row-body' as const;
/**
 * Directly above the composer, in the chat: the cards of what the ferret is stopped on (Claude Code's permission prompt
 * and harness dialog), and what a chat-level reader needs (Voice's auto-read). The chat mounts every panel contributed
 * here once, with the ferret as its `subject` and {@link ConversationAboveComposerProps} as its props; a panel draws
 * nothing when the ferret is stopped on nothing.
 */
export const CONVERSATION_ABOVE_COMPOSER_SLOT = 'conversation.above-composer' as const;

/**
 * The ferret's MODES menu, one click from its header: the switches that change what a ferret is told or may do (Agenda
 * mode, Hypermedia, Passive lessons, Compact memory at, the lessons scan). The header's main line stays the name and the
 * status; a plugin that adds a mode contributes its panel HERE, not to `ferret.toolbar`. The same menu opens with Ferrets' own
 * rows (Info and Actions, `ferrets.menu`) ahead of the modes. The chat mounts every panel
 * contributed here, with the ferret as its `subject`, inside the menu's popover (a bottom sheet on a phone).
 */
export const CONVERSATION_MODES_SLOT = 'conversation.modes' as const;

/** Every slot the chat offers, in one list a test can pair against the panels other plugins contribute. */
export const CONVERSATION_SLOTS = [
  CONVERSATION_ROW_SLOT,
  CONVERSATION_ROW_BODY_SLOT,
  CONVERSATION_ROW_ACTIONS_SLOT,
  CONVERSATION_ABOVE_COMPOSER_SLOT,
  CONVERSATION_MODES_SLOT,
] as const;
export type ConversationSlot = (typeof CONVERSATION_SLOTS)[number];

/**
 * The transcript row a panel is drawn for, as far as a contributor may rely on it. The chat hands ONLY these fields (the
 * rest of its row stays inside Conversation), built from the daemon's reading of this ferret's transcript: the words are
 * the daemon's redacted text, so a value Vault masks is masked here too. A row that exists only on this device (a send
 * that has not landed, or was refused) has not been through the daemon, so it is never offered to a slot — except the
 * person's own words, to `conversation.row-body` alone (`ConversationRowBodyProps`).
 */
export interface ConversationRowEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'notice' | 'system';
  readonly text: string;
  /** Epoch milliseconds of the row's first record, when known. */
  readonly at?: number;
  readonly label?: string;
  /**
   * The delivered send a `user` row IS (the transcript's own join to the daemon's send ledger): the exact proof of which
   * row a send became, for a contributor that follows a send's reply. Only the id; the ledger record stays inside
   * Conversation. Absent on a row that is no delivered send.
   */
  readonly send?: { readonly sendId: string };
  /** True on a `user` row another ferret sent (a peer), not the person: it is never the person's own message. */
  readonly peer?: true;
  /**
   * A `tool` row's shell calls whose whole script is exactly one plain command of a program named `fy`, and what they
   * printed, for a contributor that reads what a ferret asked of it (Packs draws the helpers a ferret started). Only a
   * call to a shell tool (Bash, exec_command, shell, local_shell) is offered, only when the script is that one command
   * (a script with a pipe, a list `; && ||`, `&`, a second line, a subshell or group, a redirect, a backtick or a `$`
   * is left out, and so is one that mixes `fy` with any other command), and only the script and the text of its answer:
   * no other command, no other tool's input, no image, no attachment. The program is identified by its NAME (`fy`, or
   * a path ending in `/fy`), not by proof of which program that is. Built from the daemon's
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

/** The props every panel in a Conversation row slot receives, beside its `subject` (the ferret). */
export interface ConversationRowProps {
  readonly entry: ConversationRowEntry;
}

/**
 * The props of a `conversation.row-body` panel, beside its `subject` (the ferret).
 *
 * THE ONE EXCEPTION to the rule that a row on this device only is never offered (`ConversationRowEntry`): a send still
 * on its way (`onItsWay`) is offered to THIS slot alone, with the words the person typed (not yet read by the daemon,
 * so not redacted), because the card that will draw it must show at once, in the same chat it is going to. A panel
 * draws it and nothing else: it does not store, send or log it.
 */
export interface ConversationRowBodyProps extends ConversationRowProps {
  /** True while the message is the person's own send that has not landed yet. */
  readonly onItsWay?: boolean;
  /**
   * The plain words, already drawn by the chat (a React node, opaque here: a contract imports no React): a panel returns
   * it as it is for a message it does not recognise.
   */
  readonly fallback: unknown;
}

/** What a ferret is stopped on, as one choice offered it: only its words. */
export interface ConversationPromptOption {
  readonly label?: string;
}

/**
 * What parks a turn on the person, as plain READ-ONLY data (nothing here can answer or choose anything), for a
 * contributor that says it aloud. Each part is absent when the ferret is stopped on no such thing, and every part is
 * absent once the ferret has ended. The words are the daemon's redacted reading.
 */
export interface ConversationNeedsInput {
  /** The question the ferret asked. */
  readonly question?: {
    readonly questions?: readonly {
      readonly question?: string;
      readonly multiSelect?: boolean;
      readonly options?: readonly ConversationPromptOption[];
    }[];
  };
  /** The tool-permission prompt its pane is parked on. */
  readonly permissionRequest?: {
    readonly tool?: string;
    readonly question?: string;
    readonly options?: readonly ConversationPromptOption[];
  };
  /** The harness's own dialog (hooks to review, a sign-in). */
  readonly harnessDialog?: { readonly title?: string; readonly options?: readonly ConversationPromptOption[] };
  /** The daemon's one-line reason, when it has nothing richer. */
  readonly turnPrompt?: string;
}

/** A send as far as a contributor may rely on it: its id and when the DAEMON accepted it. Never the message's words. */
export interface ConversationSendAcceptance {
  readonly sendId: string;
  /** ISO instant on the daemon's clock. */
  readonly acceptedAt: string;
}

/**
 * The props every panel in `conversation.above-composer` receives, beside its `subject` (the ferret). Additive: a panel
 * that reads none of them (Claude Code's permission and dialog cards) is untouched.
 *
 * Nothing leaves Conversation beyond these: no outbox or device-only row (the row rule of `ConversationRowEntry`), no
 * message text of a send (a row's words are the daemon's redacted reading; a send is only its id and instant), no
 * attachment, no pack or sent-message record.
 */
export interface ConversationAboveComposerProps {
  /** The transcript rows on screen, in the same redacted shape the row slots get. */
  readonly rows: readonly ConversationRowEntry[];
  /**
   * Whose turn it is. `state` is the daemon's `turnState` and `at` its `turnStateAt`; `state` is null for a ferret whose
   * daemon names none. `live` is true ONLY while the chat's last read of the ferret came back from the daemon and
   * nothing has failed since: a ferret not yet read, or whose latest refresh failed, is not live, so a contributor
   * never acts on a cached or unread turn.
   */
  readonly turn: {
    readonly state: 'working' | 'your-turn' | 'needs-input' | null;
    readonly at?: string;
    readonly live: boolean;
  };
  readonly needsInput: ConversationNeedsInput;
  /** The daemon's send ledger for this ferret, oldest accepted first. */
  readonly sends: readonly ConversationSendAcceptance[];
}

/** The slot the composer's context row offers (Voice's dictation, Conversation's attachments, Usage's quota). */
export const COMPOSER_TOOLS_SLOT = 'composer.tools' as const;

/**
 * What the ferret a composer belongs to says about the account it runs on: the account's name (`agent`, the name a usage
 * feed row carries) and the usage the ferret's own monitor stamped on its state. Only these facts are handed to a
 * `composer.tools` panel; no credential is among them.
 */
export interface ComposerAccount {
  readonly agent: string;
  readonly usage?: {
    readonly usageAuthOk?: boolean;
    readonly usage5hPercent?: number;
    readonly usageWeeklyPercent?: number;
    readonly usageAtLimit?: boolean;
    readonly usage5hResetAt?: number;
    readonly usageWeeklyResetAt?: number;
  };
}

/** The props every panel in `composer.tools` receives, beside its `subject` (the ferret); absent outside a ferret's chat. */
export interface ComposerToolsProps {
  readonly account?: ComposerAccount;
}

/**
 * The slot AGENDA's ask page offers (Agenda's contract/slots.ts owns the name and its props `{ ferret, ask }`; lead
 * decision Q9). Conversation contributes the ferret's conversation and composer to it. The name is written here because
 * Agenda already uses Conversation, so Conversation cannot import Agenda's contract; the shell's slot test pairs the two.
 */
export const AGENDA_CONVERSATION_SLOT = 'agenda.conversation' as const;
