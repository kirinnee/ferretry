/**
 * THE SHARED ACTIONS CONVERSATION PROVIDES (§5.2, S15; `@ferretry/app`'s `useAppHook`, Conversation's `shell.hooks`).
 *
 * Most app hooks are named by the plugin that READS them (Agenda offers `agenda.card-answer`; Board gives it). A shared
 * action is the other way round: ONE provider, MANY callers. The provider names it `<provider>.<action>` here, in its
 * own contract, and any half that imports this contract reads it with `useAppHook(daemon, 'conversation.add-to-chat')`.
 * No half needs another half's code: the name and the shape are the whole agreement.
 *
 * The action runs over the PROVIDER's client, on the daemon the caller names, under that daemon's authority as every app
 * hook does; the shell adds no authority of its own. With Conversation absent, paused on that daemon or provided twice,
 * the caller draws without the action.
 *
 * Plain data and functions (this is a contract: no framework type). The check refuses a name whose `<provider>` prefix
 * is not the plugin that provides it (`scripts/validate/app-hooks.ts`).
 */

/** Add a proved reference to a ferret's message box. */
export const CONVERSATION_ADD_TO_CHAT_HOOK = 'conversation.add-to-chat' as const;

/** What happened, honestly (the same words `composer/composer-references.ts` has always used). */
export type AddToChatOutcome = 'added' | 'duplicate' | 'no-composer' | 'rejected';

export interface AddToChatResult {
  readonly outcome: AddToChatOutcome;
  /** The sentence a surface shows after the action: the same words for every caller. */
  readonly message: string;
}

/** `conversation.add-to-chat`: put `reference` (a canonical token such as `&F12`) in the message box of `ferret`. */
export interface ConversationAddToChat {
  readonly add: (ferret: string, reference: string) => AddToChatResult;
}

/**
 * One message of the owner's that is still on THIS device, not yet on the machine. Only what a surface needs to say
 * "Saved on this device" (or "Not sent") beside the owner's words: no files, no draft-clearing data.
 */
export interface DeviceOutboxEntry {
  /** The send's id, the same one the daemon's queue and ledger use once it arrives. */
  readonly id: string;
  readonly ferretId: string;
  readonly message: string;
  /** The Agenda items the message is about (`!A3` and the like), apart from the words. */
  readonly references: readonly string[];
  /** When the owner sent it (an ISO instant). */
  readonly createdAt: string;
  /** Why it still waits, in plain words; absent before the first attempt. */
  readonly reason?: string;
  /** The machine answered "no" (not "I can't be reached"): the owner must edit or cancel it in the chat. */
  readonly refused?: true;
}

/**
 * Add to chat's sibling: `conversation.device-outbox`, this device's unsent owner messages for one ferret, READ ONLY.
 *
 * Read it with `useAppHook(daemon, CONVERSATION_DEVICE_OUTBOX_HOOK, 'conversation')`. Nothing can be edited, cancelled
 * or sent through it, and only the fields of {@link DeviceOutboxEntry} cross: the owner's own words, on the device that
 * already holds them. It is a named hook and not the above-composer slot because that slot never carries the outbox
 * (`contract/slots.ts`: no outbox or device-only row).
 */
export const CONVERSATION_DEVICE_OUTBOX_HOOK = 'conversation.device-outbox' as const;

export interface ConversationDeviceOutbox {
  /** Calls `listener` when any entry changes. Returns how to stop. */
  readonly subscribe: (listener: () => void) => () => void;
  /** This device's messages to `ferret` that have not reached the machine, oldest first; the same array until it changes. */
  readonly entries: (ferret: string) => readonly DeviceOutboxEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * THE APP HOOKS CONVERSATION OFFERS (§5.2): names for the work search's rows. A search hit carries only a card's project
 * id (a UUID) and an ask's ferret id, neither of which a reader can use. The names are Projects' (the board projects)
 * and the callsigns are Ferrets'; neither half imports the other, so Conversation OFFERS the hooks below and the plugin
 * that holds each list PROVIDES it, over its own client on one daemon. The name and the shape are the whole agreement.
 *
 * Each provider reads its list ONCE per daemon, when the bar first asks, and keeps it: a listing never fetches. Only
 * names and callsigns pass, nothing else of a project or a ferret.
 *
 * FAIL CLOSED. With no provider (not installed, not allowed on that daemon, two plugins giving the name, a list that
 * could not be read), the row draws as it does without one: the project's id is left out and no owner is named.
 */

/** Project id to project name, for labelling the cards a search finds. Provided by Projects. */
export const CONVERSATION_WORK_PROJECT_NAMES_HOOK = 'conversation.work-project-names' as const;
/** Ferret id to the ferret's callsign, for naming whose ask a search found. Provided by Ferrets. */
export const CONVERSATION_ASK_OWNERS_HOOK = 'conversation.ask-owners' as const;

/** A list a provider read once and keeps, by id. */
export interface ConversationNameList {
  /**
   * Calls `listener` when the list arrives. Returns how to stop. A list is read once, so it has one thing to say: it
   * lets go of every listener once it has said it (or has failed), and a listener added after that is never kept.
   */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Whether the one read is over, landed or failed: the list never speaks again, so there is nothing to listen for and
   * a listener would be kept for nothing. Cheap, and it does not start the read.
   */
  readonly settled: () => boolean;
  /**
   * The names read so far, the same map until it changes. The first call starts the one read of the daemon's list, so
   * a machine whose search is never opened is never asked; until it arrives (or when it failed) the map is empty.
   */
  readonly names: () => ReadonlyMap<string, string>;
}

/** `conversation.work-project-names`: project id to name, the Unfiled board included. */
export type ConversationWorkProjectNames = ConversationNameList;
/** `conversation.ask-owners`: ferret id to callsign. */
export type ConversationAskOwners = ConversationNameList;

/** Whether a provided value has the shape of a {@link ConversationNameList}. */
export const isConversationNameList = (value: unknown): value is ConversationNameList =>
  isRecord(value) &&
  typeof value.subscribe === 'function' &&
  typeof value.settled === 'function' &&
  typeof value.names === 'function';

/**
 * THE DECLARATION: every app hook Conversation offers, with the narrowing that says a provided value has its shape. The
 * `app-hooks` check pairs it with what the compiled-in halves provide.
 */
export const CONVERSATION_APP_HOOKS = {
  [CONVERSATION_WORK_PROJECT_NAMES_HOOK]: isConversationNameList,
  [CONVERSATION_ASK_OWNERS_HOOK]: isConversationNameList,
} as const;

/** The hooks Conversation provides, by name, each with the narrowing that says a value has the hook's shape. */
export const CONVERSATION_PROVIDED_APP_HOOKS = {
  [CONVERSATION_ADD_TO_CHAT_HOOK]: (value: unknown): value is ConversationAddToChat =>
    isRecord(value) && typeof value.add === 'function',
  [CONVERSATION_DEVICE_OUTBOX_HOOK]: (value: unknown): value is ConversationDeviceOutbox =>
    isRecord(value) && typeof value.subscribe === 'function' && typeof value.entries === 'function',
} as const;
