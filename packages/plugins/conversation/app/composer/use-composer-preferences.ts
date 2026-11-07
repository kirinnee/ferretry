/**
 * THE CHAT COMPOSER'S PREFERENCES, FOR ANY COMPOSER: this device's Enter-key choices, Vim mode and which suggestion
 * families open, read from the one device-controls store (`@ferretry/app`).
 *
 * A host that draws a composer beside something else (the send-back box under a card) would otherwise have to be
 * handed all of this by every page that can open it. Read here, the box behaves as the chat's does — the same Enter,
 * the same menus — wherever it is drawn. Dictation is no longer the composer's to configure: Voice's panel in the
 * `composer.tools` slot reads its own settings.
 */
import { useDaemonControls } from '@ferretry/app';
import { useMemo } from 'react';
import type { ComposerProps } from './composer.tsx';
import { composerSuggestionSwitches } from './composer-autocomplete.ts';

export type ComposerPreferences = Pick<
  ComposerProps,
  'enterKeyPreference' | 'phoneEnterKeyPreference' | 'vimMode' | 'suggestions'
>;

/** The preferences the chat composer uses for `daemonId`'s machine. */
export function useComposerPreferences(daemonId: string): ComposerPreferences {
  const { controls } = useDaemonControls(daemonId);
  const { composerEnterKey, composerPhoneEnterKey, composerVimMode, suggestionKeys, skillSuggestions } = controls;
  return useMemo(
    () => ({
      enterKeyPreference: composerEnterKey,
      phoneEnterKeyPreference: composerPhoneEnterKey,
      vimMode: composerVimMode,
      suggestions: composerSuggestionSwitches(suggestionKeys, skillSuggestions),
    }),
    [composerEnterKey, composerPhoneEnterKey, composerVimMode, suggestionKeys, skillSuggestions],
  );
}
