import type { AnswerFlags } from './answer.ts';
import type { BriefFlags, EditFlags } from './brief.ts';
import type { CardFlag } from './card-flag.ts';
import type { TabFlags } from './tab-flags.ts';

/** Options every agenda command accepts. */
export interface AgendaCommandOptions {
  /** Target another session's board; defaults to the session the command runs inside. */
  readonly session?: string;
  /** Emit the protocol payload verbatim instead of the human rendering. */
  readonly json?: boolean;
}

/** Flags that describe a new agenda item, and where its JSON body is read from. */
export interface AgendaAddOptions
  extends AgendaCommandOptions,
    Omit<BriefFlags, 'neededBy' | 'task'>,
    CardFlag,
    Pick<TabFlags, 'whereFile' | 'tabFile'> {
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A JSON body with the same fields; `-` reads standard input. */
  readonly jsonFile?: string;
  /** A Markdown file for the body; `-` reads standard input. */
  readonly bodyFile?: string;
  /** `--offer-close`: the owner's tap may also close the task the item belongs to. */
  readonly offerClose?: boolean;
  /**
   * `--new "<why none fits>"`: open a new agenda although open ones were listed as candidates (search, check, then
   * open). The reason is required.
   */
  readonly new?: string;
  /** `--related <id>`: a task to tie the item to, or an agenda item to edit instead of raising a duplicate. */
  readonly related?: string;
}

/** `fy agenda patch <id> --file <f>`: the document, and `--now` as on edit. */
export interface AgendaPatchOptions extends AgendaCommandOptions {
  /** The YAML or JSON document; `-` (the default) reads standard input. */
  readonly file?: string;
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
}

/** Flags that reword an open item. */
export interface AgendaEditOptions extends AgendaCommandOptions, Omit<EditFlags, 'neededBy'>, TabFlags {
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
  /** `--by`: when it is needed, as typed (ISO, "in 3h", "17:00"). */
  readonly by?: string;
  /** A Markdown file for the new body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags of `fy agenda rest`: what the ferret is doing. */
export interface AgendaRestOptions extends AgendaCommandOptions {
  readonly why?: string;
}

/** Flags of `fy agenda log`: the ferret's words, and which of the owner's chat messages they go with. */
export interface AgendaLogOptions extends AgendaCommandOptions {
  /** `--reply`: the ferret's answer to what the owner said in chat; the item goes back to the owner's list. */
  readonly reply?: string;
  /** `--rest`: what the ferret is doing about it; the item rests as working. */
  readonly rest?: string;
  /** `--message`: the owner's message to log, by id (the latest by default). */
  readonly message?: string;
}

/** Flags of `fy agenda split`: the new item's writing, and the tasks that go with it. */
export interface AgendaSplitOptions extends AgendaCommandOptions, Omit<BriefFlags, 'neededBy' | 'task'> {
  /** `--move-cards F12,F13`: tasks of the item that move to the new one. */
  readonly moveCards?: string;
  /** A JSON body with the same fields as `add`; `-` reads standard input. */
  readonly jsonFile?: string;
  /** A Markdown file for the new item's body; `-` reads standard input. */
  readonly bodyFile?: string;
}

/** Flags that tick or untick a step. */
export interface AgendaStepOptions extends AgendaCommandOptions {
  readonly undo?: boolean;
}

/** Flags that resolve an item. */
export interface AgendaResolveOptions extends AgendaCommandOptions, AnswerFlags {
  readonly note?: string;
  /** `done --reason`: why a question the owner has not answered is closed (recorded as the note). */
  readonly reason?: string;
}

/** Flags that surface an item. */
export interface AgendaSurfaceOptions extends AgendaCommandOptions {
  readonly why?: string;
  /** `--now`: it is urgent — an item the owner snoozed wakes too (at most once an hour). */
  readonly now?: boolean;
}

/** Flags that snooze an item: exactly one of them. */
export interface AgendaSnoozeOptions extends AgendaCommandOptions {
  /** `--for`: how long, as typed ("4h", "90m", "1d"). */
  readonly for?: string;
  /** `--until`: when it comes back, as typed (ISO, "in 3h", "17:00"). */
  readonly until?: string;
}
