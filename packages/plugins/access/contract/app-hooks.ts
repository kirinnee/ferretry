/**
 * THE SHARED ACTIONS ACCESS PROVIDES (§5.2, S15; `@ferretry/app`'s `useAppHook`, Access's `shell.hooks`).
 *
 * A shared action is one provider, many callers: Access names it `<provider>.<action>` here, in its own contract, and any
 * half that imports this contract reads it with `useAppHook(daemon, 'access.how-to-enable-location', 'access')`. No half
 * needs another half's code: the name and the shape are the whole agreement. With Access absent, paused on that daemon
 * or provided twice, the caller draws as it does without the action.
 *
 * Plain data and functions (this is a contract: no framework type). The check refuses a name whose `<provider>` prefix
 * is not the plugin that provides it (`scripts/validate/app-hooks.ts`).
 */

/** The steps to switch this device's location permission back on, for the kind of device this is. */
export const ACCESS_HOW_TO_ENABLE_LOCATION_HOOK = 'access.how-to-enable-location' as const;

/** `access.how-to-enable-location`: ordered, imperative steps, read at the moment they are drawn. */
export type AccessHowToEnableLocation = () => readonly string[];

/** The hooks Access provides, by name, each with the narrowing that says a value has the hook's shape. */
export const ACCESS_PROVIDED_APP_HOOKS = {
  [ACCESS_HOW_TO_ENABLE_LOCATION_HOOK]: (value: unknown): value is AccessHowToEnableLocation =>
    typeof value === 'function',
} as const;
