/**
 * Conversation-width chooser with an immediate visual preview.
 *
 * Three measures for the conversation's TEXT COLUMN — the transcript's messages
 * and the composer under them, which always share one width and one pair of
 * edges: Compact (720px), 1200px, and Full (the pane). The pane, its tab strip
 * and the scroller never narrow. All three are maximums, so in a pane narrower
 * than a measure they look the same; the preview beside the radios still moves,
 * which is what stops a mode chosen on a phone looking like a dead control.
 *
 * The persisted ids are `readable`, `balanced` and `full` (the device controls' `chatWidth`).
 */

import { useId } from 'react';
import {
  type ChatWidthPreference as ChatWidth,
  cn,
  Segmented,
  SettingGroup,
  SettingRow,
  useDeviceControls,
} from '@ferretry/app';
import { ChatWidthPreview } from './composer/previews/index.ts';

export interface ChatWidthOption {
  readonly id: ChatWidth;
  readonly label: string;
  readonly description: string;
}

export const CHAT_WIDTH_OPTIONS: readonly ChatWidthOption[] = [
  {
    id: 'readable',
    label: 'Compact',
    description: 'Default. A 720px column, centred — easiest to read.',
  },
  {
    id: 'balanced',
    label: '1200px',
    description: 'A 1200px column, with room for code and wide tables.',
  },
  {
    id: 'full',
    label: 'Full',
    description: 'The whole width of the conversation pane.',
  },
];

const PREVIEW_LABEL: Readonly<Record<ChatWidth, string>> = {
  readable: 'Compact · 720px · default',
  balanced: '1200px · room for code',
  full: 'Full · the whole pane',
};

const ACTIVE_EXPLANATION: Readonly<Record<ChatWidth, string>> = {
  full: 'Full is active: messages and the composer use the whole pane.',
  balanced: '1200px is active: messages and the composer stay within a 1200px column.',
  readable: 'Compact is active: messages and the composer stay within a 720px column.',
};

export interface ChatWidthControlProps {
  readonly value: ChatWidth;
  readonly onChange: (value: ChatWidth) => void;
}

export function ChatWidthControl({ value, onChange }: ChatWidthControlProps) {
  const explanationId = useId();

  return (
    <>
      <fieldset aria-describedby={explanationId} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <legend className="sr-only">Conversation width</legend>
        {CHAT_WIDTH_OPTIONS.map(option => {
          const checked = value === option.id;
          return (
            <label
              key={option.id}
              className={cn(
                'flex min-h-control min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                checked
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg hover:border-accent',
              )}
            >
              <input
                type="radio"
                name="chat-width"
                value={option.id}
                checked={checked}
                onChange={() => onChange(option.id)}
                className="sr-only"
              />
              <span className="text-ui font-semibold">{option.label}</span>
              <span className="text-meta leading-tight text-muted">{option.description}</span>
            </label>
          );
        })}
      </fieldset>

      <div className="mt-3 rounded-control border border-border-soft bg-surface-2 p-2.5">
        <div className="flex items-center justify-between gap-2 text-meta text-muted">
          <span>Conversation preview</span>
          <span>{PREVIEW_LABEL[value]}</span>
        </div>
        <ChatWidthPreview value={value} />
      </div>

      <p id={explanationId} aria-live="polite" className="mt-2 text-meta leading-base text-faint">
        {ACTIVE_EXPLANATION[value]} In a pane narrower than the column — a phone, or beside a split pane — the choices
        look the same.
      </p>
    </>
  );
}

const WIDTH_HINT: Readonly<Record<ChatWidth, string>> = {
  readable: 'Compact — a 720px column, centred',
  balanced: '1200px — room for code and wide tables',
  full: 'Full — the whole conversation pane',
};

/**
 * The `device.settings` panel: this device's conversation width, read from and written to the one controls store. A
 * labelled row of the Layout group — its name, the width now in force, and the three choices under it — like every
 * other setting, not three loose boxes.
 */
export function ChatWidthPanel() {
  const { device, set } = useDeviceControls();
  return (
    <SettingGroup label="Conversation">
      <SettingRow
        settingId="conversation-width"
        name="Conversation width"
        hint={WIDTH_HINT[device.chatWidth]}
        explanation="How wide the messages and the composer are in a conversation. All three are maximums, so in a pane narrower than the column (a phone, or beside a split pane) they look the same. Applies to this device."
        wide
        control={() => (
          <div className="w-full md:w-72">
            <Segmented
              fill
              label="Conversation width"
              value={device.chatWidth}
              options={CHAT_WIDTH_OPTIONS.map(({ id, label, description }) => ({ id, label, title: description }))}
              onChange={chatWidth => set({ chatWidth })}
            />
          </div>
        )}
      />
    </SettingGroup>
  );
}
