/**
 * Settings controls for how the composer EDITS text: the Markdown
 * syntax-highlight overlay, and optional Vim-style modal keys — and how the
 * phone composer lays out its buttons (`lib/composer-dock-layout.ts`).
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
import {
  type ComposerDockLayout,
  useComposerDockLayout,
  writeComposerDockLayout,
} from '../../lib/composer-dock-layout.ts';
import { type MdComposePref, useMdComposePref, writeMdComposePref } from '../../lib/md-compose.ts';

export const MARKDOWN_COMPOSER_EXPLANATION =
  'Whichever style, what you send is markdown, and the @ / : suggestions and Vim keys work in all three. In Markdown style the text formats as you type — # headings at their real size, - and 1. lists that continue on Enter, [ ] checklists, > quotes, ``` code and --- dividers, with **bold** bold and *italic* slanted — and the markers kept faintly visible. Rich text formats the same way, hides the markers except on the line you are editing, and adds a formatting toolbar. ⌘B, ⌘I and ⌘E wrap the selection; ⌘⇧8 and ⌘⇧7 make lists.';

/** The editor styles this build offers, and what each is called on screen. */
const EDITOR_STYLES: readonly { readonly pref: MdComposePref; readonly label: string; readonly detail: string }[] = [
  { pref: 'on', label: 'Markdown, Notion-style', detail: 'Formats as you type, markers kept faintly visible' },
  {
    pref: 'rich',
    label: 'Rich text',
    detail: 'Formats as you type, markers hidden, with a toolbar; still sends markdown',
  },
  { pref: 'off', label: 'Plain text box', detail: 'No formatting and no list continuation' },
];

/** How the phone composer lays out attach and the mic, Interrupt & send and Send. */
const DOCK_LAYOUTS: readonly { readonly value: ComposerDockLayout; readonly label: string; readonly detail: string }[] =
  [
    { value: 'stacked', label: 'Stacked', detail: 'Buttons in a column each side, always — the most room to type' },
    {
      value: 'row',
      label: 'One row',
      detail: 'Buttons side by side, always: a slimmer box, a little less room to type.',
    },
    { value: 'auto', label: 'Auto', detail: 'Side by side while empty, stacked once you type' },
  ];

export const DOCK_LAYOUT_EXPLANATION =
  'On a phone, attach and the mic sit on the left of the box, Send on the right. Stacked and One row never move as you start or stop typing; Auto switches between them, so the buttons move when the first letter goes in. A desktop always keeps them in one row. Kept on this device.';

export const VIM_COMPOSER_EXPLANATION =
  'Modal Vim keys — normal and insert — in every editor style, with the mode shown under the message box. Off by default. Leaving insert mode is Escape, which a phone’s on-screen keyboard does not offer, so this is only useful with a physical keyboard (the mode indicator also switches modes).';

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
  const dockLayout = useComposerDockLayout();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-ui font-semibold text-fg">Editor style</legend>
          {EDITOR_STYLES.map(style => (
            <label
              className={cn(
                'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-control border px-control-x py-2',
                pref === style.pref ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
              )}
              data-editor-style={style.pref}
              key={style.pref}
            >
              <input
                checked={pref === style.pref}
                className="mt-1"
                name="composer-editor-style"
                onChange={() => writeMdComposePref(style.pref)}
                type="radio"
                value={style.pref}
              />
              <span className="min-w-0">
                <span className="block text-ui font-semibold text-fg">{style.label}</span>
                <span className="mt-0.5 block text-meta leading-base text-muted">{style.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="m-0 text-cell leading-base text-muted">{MARKDOWN_COMPOSER_EXPLANATION}</p>
      </div>
      <div className="flex flex-col gap-2">
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-ui font-semibold text-fg">Button layout</legend>
          {DOCK_LAYOUTS.map(layout => (
            <label
              className={cn(
                'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-control border px-control-x py-2',
                dockLayout === layout.value
                  ? 'border-accent bg-accent-soft'
                  : 'border-border bg-surface-2 hover:border-accent',
              )}
              data-dock-layout={layout.value}
              key={layout.value}
            >
              <input
                checked={dockLayout === layout.value}
                className="mt-1"
                name="composer-dock-layout"
                onChange={() => writeComposerDockLayout(layout.value)}
                type="radio"
                value={layout.value}
              />
              <span className="min-w-0">
                <span className="block text-ui font-semibold text-fg">{layout.label}</span>
                <span className="mt-0.5 block text-meta leading-base text-muted">{layout.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="m-0 text-cell leading-base text-muted">{DOCK_LAYOUT_EXPLANATION}</p>
      </div>
      <div className="flex flex-col gap-2">
        <ComposerSwitch
          checked={vimEnabled}
          label="Vim-style editing"
          detail="Physical keyboard · NORMAL and INSERT shown under the box"
          onChange={onChangeVim}
        />
        <p className="m-0 text-cell leading-base text-muted">{VIM_COMPOSER_EXPLANATION}</p>
      </div>
    </div>
  );
}
