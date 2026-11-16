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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The hooks Conversation provides, by name, each with the narrowing that says a value has the hook's shape. */
export const CONVERSATION_PROVIDED_APP_HOOKS = {
  [CONVERSATION_ADD_TO_CHAT_HOOK]: (value: unknown): value is ConversationAddToChat =>
    isRecord(value) && typeof value.add === 'function',
} as const;
