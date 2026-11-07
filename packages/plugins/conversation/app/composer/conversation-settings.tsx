/**
 * THE CONVERSATION SETTINGS TAB (`settings.conversation`): the composer's three device choices — the editor style
 * (with Vim keys and the phone button layout), the send key, and which keys open the reference menus — each in the
 * section today's Settings page drew it in, with today's label and description. They are this device's controls
 * (`@ferretry/app`'s one device-controls store), so a change here is the change every composer on this device reads.
 * The message-marks legend joins this tab with the chat (C3).
 */
import { useDeviceControls } from '@ferretry/app';
import type { ReactNode } from 'react';
import { ComposerEnterKeySettings } from './composer-enter-key-settings.tsx';
import { ComposerSuggestionsSettings } from './composer-suggestions-settings.tsx';
import { MarkdownComposerSettings } from './markdown-composer-settings.tsx';

interface SectionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** Today's settings-catalog entries for the three, word for word. */
const SECTIONS = {
  markdown: {
    id: 'composer-markdown',
    label: 'Editor style',
    description:
      'Markdown, Notion-style (the default) formats as you type — headings at their real size, bold, lists that continue on Enter, checklists, quotes, code — with the markers kept faintly visible; Rich text hides the markers and adds a toolbar; or choose a plain text box. Whichever style, you send markdown. Optional Vim-style modal keys live here too.',
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
    description:
      'Choose which keys open the composer’s reference menu: the @ ladder (@ files, @@ agents, @@@ agenda, @@@@ tasks), the direct symbols (@ files, :agent, !agenda, &task), or both; and whether $ opens skills. Suggestions only — a reference you write or paste yourself still resolves and links, and the / and % menus always open.',
  },
} as const satisfies Record<string, SectionDefinition>;

/** One section, drawn as today's `SettingsSection`. */
function SettingsSection({
  definition,
  children,
}: {
  readonly definition: SectionDefinition;
  readonly children: ReactNode;
}) {
  const headingId = `settings-${definition.id}-heading`;
  return (
    <section
      id={`settings-${definition.id}`}
      data-setting-id={definition.id}
      tabIndex={-1}
      className="kt-panel p-panel outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="m-0 text-row font-semibold text-fg">
        {definition.label}
      </h3>
      <p className="mt-1 text-cell leading-base text-muted">{definition.description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function ConversationSettings(): ReactNode {
  const { device, set } = useDeviceControls();
  return (
    <>
      <SettingsSection definition={SECTIONS.markdown}>
        <MarkdownComposerSettings
          vimEnabled={device.composerVimMode}
          onChangeVim={composerVimMode => set({ composerVimMode })}
        />
      </SettingsSection>
      <SettingsSection definition={SECTIONS.enterKey}>
        <ComposerEnterKeySettings
          preference={device.composerEnterKey}
          phonePreference={device.composerPhoneEnterKey}
          onChange={patch => set(patch)}
        />
      </SettingsSection>
      <SettingsSection definition={SECTIONS.suggestions}>
        <ComposerSuggestionsSettings preferences={device} onChange={patch => set(patch)} />
      </SettingsSection>
    </>
  );
}
