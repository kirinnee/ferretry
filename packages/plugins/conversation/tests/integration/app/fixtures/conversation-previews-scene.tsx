/**
 * The browser entry for the Conversation tab previews: the REAL send-key, editor-style, suggestions and chat-width
 * settings, each holding its choice in local state (fake data, no daemon, no network).
 *
 * The sections are drawn INSIDE the Settings shell's own frame (`.fy-page .fy-settings`, its two-column body with the nav
 * column held empty, and `.fy-settings-page`), so the shell's `.fy-page label` rules and the real content width apply.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 */
import { type ChatWidthPreference, type ComposerEnterKeyPreference, type SuggestionKeys } from '@ferretry/app';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWidthControl } from '../../../../app/chat-width-control.tsx';
import { ComposerEnterKeySettings } from '../../../../app/composer/composer-enter-key-settings.tsx';
import { ComposerSuggestionsSettings } from '../../../../app/composer/composer-suggestions-settings.tsx';
import { MarkdownComposerSettings } from '../../../../app/composer/markdown-composer-settings.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

function Scene() {
  const [keyboard, setKeyboard] = useState<ComposerEnterKeyPreference | null>(null);
  const [phone, setPhone] = useState<ComposerEnterKeyPreference | null>(null);
  const [suggestionKeys, setSuggestionKeys] = useState<SuggestionKeys>('ladder');
  const [skillSuggestions, setSkillSuggestions] = useState(true);
  const [vim, setVim] = useState(false);
  const [width, setWidth] = useState<ChatWidthPreference>('balanced');
  return (
    <div className="flex flex-col gap-4">
      <section className="kt-panel p-panel" data-scene="editor">
        <h3 className="m-0 text-row font-semibold text-fg">Editor style</h3>
        <div className="mt-3">
          <MarkdownComposerSettings vimEnabled={vim} onChangeVim={setVim} />
        </div>
      </section>
      <section className="kt-panel p-panel" data-scene="send-key">
        <h3 className="m-0 text-row font-semibold text-fg">Send key</h3>
        <div className="mt-3">
          <ComposerEnterKeySettings
            preference={keyboard}
            phonePreference={phone}
            onChange={patch => {
              if (patch.composerEnterKey !== undefined) setKeyboard(patch.composerEnterKey);
              if (patch.composerPhoneEnterKey !== undefined) setPhone(patch.composerPhoneEnterKey);
            }}
          />
        </div>
      </section>
      <section className="kt-panel p-panel" data-scene="suggestions">
        <h3 className="m-0 text-row font-semibold text-fg">Open suggestions with</h3>
        <div className="mt-3">
          <ComposerSuggestionsSettings
            preferences={{ suggestionKeys, skillSuggestions }}
            onChange={patch => {
              if (patch.suggestionKeys !== undefined) setSuggestionKeys(patch.suggestionKeys);
              if (patch.skillSuggestions !== undefined) setSkillSuggestions(patch.skillSuggestions);
            }}
          />
        </div>
      </section>
      <section className="kt-panel p-panel" data-scene="chat-width">
        <h3 className="m-0 text-row font-semibold text-fg">Conversation width</h3>
        <div className="mt-3">
          <ChatWidthControl value={width} onChange={setWidth} />
        </div>
      </section>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <section className="fy-page fy-settings" data-settings-open="panel">
      <div className="fy-settings-body">
        <div aria-hidden="true" className="fy-settings-nav" />
        <section className="fy-settings-page" aria-label="Conversation">
          <Scene />
        </section>
      </div>
    </section>,
  );
