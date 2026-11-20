/**
 * THE CONVERSATION SETTINGS TAB (`settings.conversation`): the composer's three device choices — the editor style
 * (with Vim keys and the phone button layout), the send key, and which keys open the reference menus — each in the
 * section today's Settings page drew it in, with today's label and description. They are this device's controls
 * (`@ferretry/app`'s one device-controls store), so a change here is the change every composer on this device reads.
 * The message-marks legend joins this tab with the chat (C3).
 */
import { SettingGroup, SettingRow, useDeviceControls } from '@ferretry/app';
import type { ReactNode } from 'react';
import { ComposerEnterKeySettings } from './composer-enter-key-settings.tsx';
import { COMPOSER_SUGGESTIONS_INTRO, ComposerSuggestionsSettings } from './composer-suggestions-settings.tsx';
import { MarkdownComposerSettings } from './markdown-composer-settings.tsx';

interface SectionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** The three groups. The Style description is the Style row's (i) text (`EDITOR_STYLE_INTRO`); the others are their rows' hint and (i). */
const SECTIONS = {
  markdown: {
    id: 'composer-markdown',
    label: 'Editor style',
  },
  enterKey: {
    id: 'composer-enter-key',
    label: 'Send key',
    description:
      'Choose, separately for a keyboard and for a phone, whether Enter sends or starts a new line. On a keyboard ↵ sends and ⇧↵ starts a line by default; on a phone return starts a line and the ↑ button sends. ⌘/Ctrl+↵ always sends.',
  },
  suggestions: {
    id: 'composer-suggestions',
    label: 'Open suggestions with',
    description: COMPOSER_SUGGESTIONS_INTRO,
  },
} as const satisfies Record<string, SectionDefinition>;

/** The body of a setting row that is not a one-line control: the same left edge as the row's name. */
function Body({ children }: { readonly children: ReactNode }) {
  return <div className="min-w-0 pb-3 pl-panel pr-1 pt-1">{children}</div>;
}

export function ConversationSettings(): ReactNode {
  const { device, set } = useDeviceControls();
  return (
    <>
      <SettingGroup label={SECTIONS.markdown.label} settingId={SECTIONS.markdown.id}>
        <MarkdownComposerSettings
          vimEnabled={device.composerVimMode}
          onChangeVim={composerVimMode => set({ composerVimMode })}
        />
      </SettingGroup>
      <SettingGroup label={SECTIONS.enterKey.label} settingId={SECTIONS.enterKey.id}>
        <SettingRow
          name="Enter key"
          hint="Whether Enter sends or starts a new line."
          explanation={SECTIONS.enterKey.description}
        >
          <Body>
            <ComposerEnterKeySettings
              preference={device.composerEnterKey}
              phonePreference={device.composerPhoneEnterKey}
              onChange={patch => set(patch)}
            />
          </Body>
        </SettingRow>
      </SettingGroup>
      <SettingGroup label={SECTIONS.suggestions.label} settingId={SECTIONS.suggestions.id}>
        <SettingRow name="Menu keys" hint={SECTIONS.suggestions.description}>
          <Body>
            <ComposerSuggestionsSettings preferences={device} onChange={patch => set(patch)} />
          </Body>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
