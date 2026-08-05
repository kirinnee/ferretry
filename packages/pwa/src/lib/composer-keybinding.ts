/**
 * Reader-local message-composer key behaviour.
 *
 * The stored choice is deliberately only the bare Enter action. Shift reverses
 * it on keyboards that have Shift; touch devices instead retain their visible
 * Send button, and expose a visible New line button if Enter sends. That keeps
 * both actions reachable even where a virtual keyboard has no modifier key.
 */

export type ComposerEnterKeyPreference = 'send' | 'newline';
export type ComposerEnterAction = ComposerEnterKeyPreference;

/** `null` means use the device’s considered default: desktop sends, touch writes a line break. */
export const composerEnterAction = (
  preference: ComposerEnterKeyPreference | null | undefined,
  desktopKeyboard: boolean,
): ComposerEnterAction => preference ?? (desktopKeyboard ? 'send' : 'newline');

/** The modified Enter action on a hardware keyboard is always the opposite of bare Enter. */
export const shiftedComposerEnterAction = (bare: ComposerEnterAction): ComposerEnterAction =>
  bare === 'send' ? 'newline' : 'send';

export const composerEnterHint = (bare: ComposerEnterAction, touchAffected: boolean): string => {
  if (touchAffected)
    return bare === 'send' ? 'Enter to send · use New line for a new line' : 'Enter for a new line · use Send to send';
  return bare === 'send' ? 'Enter to send · Shift+Enter for a new line' : 'Enter for a new line · Shift+Enter to send';
};
