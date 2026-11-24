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
import { ChoiceCards, SettingRow, SettingSwitch } from '@ferretry/app';
import type { ReactNode } from 'react';
import { type ComposerDockLayout, useComposerDockLayout, writeComposerDockLayout } from './composer-dock-layout.ts';
import { type MdComposePref, useMdComposePref, writeMdComposePref } from '@ferretry/app';
import { DockLayoutSample, EditorStyleSample } from './previews/index.ts';
import './markdown-composer-settings.css';

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

/** The cards' options, and the one line under them that says what the chosen card does (only what is selected). */
const EDITOR_OPTIONS = EDITOR_STYLES.map(style => ({
  id: style.pref,
  title: style.label,
  demo: <EditorStyleSample pref={style.pref} />,
}));
const DOCK_OPTIONS = DOCK_LAYOUTS.map(layout => ({
  id: layout.value,
  title: layout.label,
  demo: <DockLayoutSample layout={layout.value} />,
}));

/** The group's one-paragraph intro, which was the section's description and now sits behind the Style row's (i). */
const EDITOR_STYLE_INTRO =
  'Markdown, Notion-style (the default) formats as you type — headings at their real size, bold, lists that continue on Enter, checklists, quotes, code — with the markers kept faintly visible; Rich text hides the markers and adds a toolbar; or choose a plain text box. Whichever style, you send markdown. Optional Vim-style modal keys live here too.';

/** The cards (one row, each with its own sample) and the line for the chosen one under them. */
function CardsBody({
  caption,
  captionAttribute,
  children,
}: {
  readonly caption: string;
  readonly captionAttribute: `data-${string}`;
  readonly children: ReactNode;
}) {
  return (
    <div className="fy-cm-body">
      <div className="fy-cm-main">
        <div className="fy-cm-cards">{children}</div>
        <p className="fy-cm-caption" {...{ [captionAttribute]: '' }}>
          {caption}
        </p>
      </div>
    </div>
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
  const style = EDITOR_STYLES.find(candidate => candidate.pref === pref);
  const layout = DOCK_LAYOUTS.find(candidate => candidate.value === dockLayout);

  return (
    <>
      <SettingRow
        name="Style"
        hint="Formats as you type; you always send markdown."
        explanation={
          <>
            <p className="m-0">{EDITOR_STYLE_INTRO}</p>
            <p className="m-0 mt-2">{MARKDOWN_COMPOSER_EXPLANATION}</p>
          </>
        }
      >
        <CardsBody caption={style?.detail ?? ''} captionAttribute="data-editor-style-detail">
          <ChoiceCards
            label="Editor style"
            onChange={next => writeMdComposePref(next as MdComposePref)}
            options={EDITOR_OPTIONS}
            value={pref}
          />
        </CardsBody>
      </SettingRow>
      <SettingRow
        name="Button layout"
        hint="How the phone composer lays out its buttons."
        explanation={DOCK_LAYOUT_EXPLANATION}
      >
        <CardsBody caption={layout?.detail ?? ''} captionAttribute="data-dock-layout-detail">
          <ChoiceCards
            label="Button layout"
            onChange={next => writeComposerDockLayout(next as ComposerDockLayout)}
            options={DOCK_OPTIONS}
            value={dockLayout}
          />
        </CardsBody>
      </SettingRow>
      <SettingRow
        name="Vim-style editing"
        hint="Physical keyboard only"
        explanation={
          <>
            <p className="m-0">NORMAL and INSERT shown under the box.</p>
            <p className="m-0 mt-2">{VIM_COMPOSER_EXPLANATION}</p>
          </>
        }
        control={labelId => <SettingSwitch checked={vimEnabled} labelledBy={labelId} onChange={onChangeVim} />}
      />
    </>
  );
}
