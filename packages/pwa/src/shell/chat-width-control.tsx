/**
 * Conversation-width chooser with an immediate visual preview.
 *
 * Ported from kteam `ui/src/components/ChatWidthControl.tsx`.
 *
 * Full-bleed is already the persisted default, and all three choices are
 * intentionally identical below the readable cap. Showing their proportions
 * beside the radios is what stops selecting a mode on a phone looking like a
 * dead control — the preview moves even when the conversation cannot.
 */

import { useId } from 'react';
import { cn } from '../lib/class-names.ts';

/**
 * The persisted width mode. Declared here rather than imported from a store:
 * kteam kept it in `lib/store`, which this repo has not ported, and the control
 * is the module that actually defines the three modes.
 */
export type ChatWidth = 'full' | 'balanced' | 'readable';

export interface ChatWidthOption {
  readonly id: ChatWidth;
  readonly label: string;
  readonly description: string;
}

export const CHAT_WIDTH_OPTIONS: readonly ChatWidthOption[] = [
  {
    id: 'readable',
    label: 'Comfortable',
    description: 'Default. About 75 characters a line, centred.',
  },
  {
    id: 'balanced',
    label: 'Wide',
    description: 'Caps wide conversations at 900px, with room for code and tables.',
  },
  {
    id: 'full',
    label: 'Full',
    description: 'Expands the conversation to the available desktop width.',
  },
];

const PREVIEW_LABEL: Readonly<Record<ChatWidth, string>> = {
  readable: 'Comfortable · ~75 characters · default',
  balanced: 'Wide · 900px max',
  full: 'Full · the whole pane',
};

const PREVIEW_WIDTH_CLASS: Readonly<Record<ChatWidth, string>> = {
  full: 'w-full',
  balanced: 'w-5/6 max-w-[220px]',
  readable: 'w-2/3 max-w-[180px]',
};

const ACTIVE_EXPLANATION: Readonly<Record<ChatWidth, string>> = {
  full: 'Full is active: the conversation uses the whole pane.',
  balanced: 'Wide is active. It keeps wide conversations within 900px without narrowing to Comfortable.',
  readable: 'Comfortable is active. Wide and Full use extra width in a wider conversation.',
};

export interface ChatWidthControlProps {
  readonly value: ChatWidth;
  readonly onChange: (value: ChatWidth) => void;
}

export function ChatWidthControl({ value, onChange }: ChatWidthControlProps) {
  const explanationId = useId();

  return (
    <>
      {/*
        kteam wrote the three options as `<button role="radio">`. Native radios
        inside a fieldset carry the same semantics without an explicit role, and
        satisfy the repo's a11y gate the way `view-tabs.tsx` already does — with
        the bonus that arrow-key selection comes from the browser rather than
        from hand-written key handling. The input is visually hidden and the
        label keeps the card silhouette exactly, so nothing about the rendering
        changes. One behavioural consequence, and it is the documented one:
        re-selecting the mode already in force no longer calls `onChange`, which
        is the no-op the explanation text below already promises.
      */}
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
        <div
          aria-hidden="true"
          className="mt-2 flex h-10 w-full items-center justify-center rounded-control bg-surface px-2"
        >
          <div
            data-chat-width-preview={value}
            className={cn(
              'flex h-6 flex-col justify-center gap-1 rounded-sm border border-accent/50 bg-accent-soft px-2 transition-[width] duration-150',
              PREVIEW_WIDTH_CLASS[value],
            )}
          >
            <span className="block h-px w-4/5 bg-accent/50" />
            <span className="block h-px w-3/5 bg-accent/30" />
          </div>
        </div>
      </div>

      <p id={explanationId} aria-live="polite" className="mt-2 text-meta leading-base text-faint">
        {ACTIVE_EXPLANATION[value]} When the conversation pane is 768px wide or narrower, all three choices look the
        same.
      </p>
    </>
  );
}
