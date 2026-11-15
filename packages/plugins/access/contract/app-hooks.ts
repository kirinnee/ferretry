/**
 * THE APP HOOKS ACCESS OFFERS (§5.2; `@ferretry/app`'s `useAppHook`, a provider's `shell.hooks`).
 *
 * Settings › This device › Notifications lists every machine this browser reaches, and each row can MUTE its machine:
 * this browser then shows nothing from it. Which machines a browser silences is the reader's notification filter,
 * which is Agenda's store, and neither half imports the other. Access OFFERS the hook below and Agenda PROVIDES it
 * over its filter store, one value per daemon. The name and the shape are the whole agreement; Access narrows what it
 * is given before it reads it.
 *
 * FAIL CLOSED. With no provider the row draws no Mute: the machine's enrol switch is still there.
 *
 * The value is plain data and functions (no framework type: this is a contract).
 */

/** Whether this browser shows what one machine sends. */
export const ACCESS_MACHINE_MUTE_HOOK = 'access.machine-mute' as const;

/** `access.machine-mute`: one machine's mute, as this browser keeps it. */
export interface AccessMachineMute {
  readonly subscribe: (listener: () => void) => () => void;
  /** This browser shows nothing from the machine. The same answer until it changes. */
  readonly muted: () => boolean;
  readonly setMuted: (muted: boolean) => void;
}

/** A provided value is read only when it has the shape: anything else is no provider. */
export const isAccessMachineMute = (value: unknown): value is AccessMachineMute =>
  typeof value === 'object' &&
  value !== null &&
  ['subscribe', 'muted', 'setMuted'].every(name => typeof (value as Record<string, unknown>)[name] === 'function');

/** THE DECLARATION: every app hook Access offers, with the narrowing that says a provided value has its shape. */
export const ACCESS_APP_HOOKS = {
  [ACCESS_MACHINE_MUTE_HOOK]: isAccessMachineMute,
} as const;
export type AccessAppHook = keyof typeof ACCESS_APP_HOOKS;
