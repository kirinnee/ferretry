/**
 * Settings controls for how the composer EDITS text: the Markdown
 * syntax-highlight overlay, and optional Vim-style modal keys.
 *
 * Ported from kteam `ui/src/components/MarkdownComposerSettings.tsx`. The
 * original deliberately keeps this separate from the contended settings page;
 * the PWA likewise exports a composable settings surface rather than coupling
 * it to a particular route host.
 *
 * Both switches share one promise, which is why they share one surface: the
 * native textarea remains the input owner. Highlighting paints behind it and
 * Vim keys reinterpret keystrokes inside it — neither swaps in an editor
 * component, and neither takes over the draft, the selection, dictation or
 * autocomplete. Their storage owners differ (the display preference has its own
 * key; the Vim preference is a device control) and that is deliberate: this
 * surface reads both and owns neither.
 */
import { cn } from '../../lib/class-names.ts';
import { MD_COMPOSE_DEFAULT, useMdComposePref, writeMdComposePref } from '../../lib/md-compose.ts';

export const MARKDOWN_COMPOSER_EXPLANATION =
  'Markdown markers stay visible in the native textarea. A separate bounded preview renders headings, lists, emphasis, code, links, and proven in-app references while you type.';

export const VIM_COMPOSER_EXPLANATION =
  'Modal Vim keys — normal and insert — inside the same message textarea. Off by default. Leaving insert mode is Escape, which a phone’s on-screen keyboard does not offer, so this is only useful with a physical keyboard.';

function ComposerSwitch({
  checked,
  label,
  detail,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly detail: string;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-control-x py-2 text-left hover:border-accent',
      )}
      onClick={() => onChange(!checked)}
    >
      <span className="min-w-0">
        <span className="block text-ui font-semibold text-fg">{label}</span>
        <span className="mt-0.5 block text-meta leading-base text-muted">{detail}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-fg transition-transform',
            checked ? 'translate-x-[20px]' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  );
}

export function MarkdownComposerSettings({
  vimEnabled,
  onChangeVim,
}: {
  /** Device-local Vim preference, read by the host from the controls store. */
  readonly vimEnabled: boolean;
  readonly onChangeVim: (enabled: boolean) => void;
}) {
  const pref = useMdComposePref();
  const enabled = pref === 'on';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <ComposerSwitch
          checked={enabled}
          label="Highlight Markdown syntax"
          detail="Native textarea · no editor swap"
          onChange={next => writeMdComposePref(next ? 'on' : 'off')}
        />
        <p className="m-0 text-ui leading-base text-muted">{MARKDOWN_COMPOSER_EXPLANATION}</p>
        {MD_COMPOSE_DEFAULT === 'off' && (
          <p className="m-0 text-meta leading-base text-faint">
            Off by default while this experience receives a real-device mobile Safari pass. Enabling it changes
            presentation only; the original textarea still owns input, selection, dictation, autocomplete and drafts.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <ComposerSwitch
          checked={vimEnabled}
          label="Vim-style editing"
          detail="Physical keyboard · native textarea keeps input"
          onChange={onChangeVim}
        />
        <p className="m-0 text-ui leading-base text-muted">{VIM_COMPOSER_EXPLANATION}</p>
      </div>
    </div>
  );
}
