/**
 * Settings controls for how the composer EDITS text, as three compact rows: the editor style (Markdown,
 * Rich text, Plain), how the phone composer lays out its buttons (`lib/composer-dock-layout.ts`), and
 * optional Vim-style modal keys.
 *
 * Ported from kteam `ui/src/components/MarkdownComposerSettings.tsx`. The original deliberately keeps this
 * separate from the contended settings page; the PWA likewise exports a composable settings surface rather
 * than coupling it to a particular route host.
 *
 * Every row shares one promise, which is why they share one surface: the native textarea remains the input
 * owner. Highlighting paints behind it and Vim keys reinterpret keystrokes inside it — neither swaps in an
 * editor component, and neither takes over the draft, the selection, dictation or autocomplete. Their storage
 * owners differ (the display preference has its own key; the Vim preference is a device control) and that is
 * deliberate: this surface reads both and owns neither.
 *
 * The long paragraphs live behind each row's (i); the row's hint says what the CHOSEN option does.
 */
import {
  type ComposerDockLayout,
  useComposerDockLayout,
  writeComposerDockLayout,
} from '../../lib/composer-dock-layout.ts';
import { type MdComposePref, useMdComposePref, writeMdComposePref } from '../../lib/md-compose.ts';
import { OptionNotes, Segmented, SettingRow, SettingSwitch } from './setting-row.tsx';
import { settingDefinition } from './settings-catalog.ts';

export const MARKDOWN_COMPOSER_EXPLANATION =
  'Whichever style, what you send is markdown, and the @ / : suggestions and Vim keys work in all three. In Markdown style the text formats as you type — # headings at their real size, - and 1. lists that continue on Enter, [ ] checklists, > quotes, ``` code and --- dividers, with **bold** bold and *italic* slanted — and the markers kept faintly visible. Rich text formats the same way, hides the markers except on the line you are editing, and adds a formatting toolbar. ⌘B, ⌘I and ⌘E wrap the selection; ⌘⇧8 and ⌘⇧7 make lists.';

/** The editor styles this build offers: the short name on the control, the full name and sentence behind (i). */
const EDITOR_STYLES: readonly {
  readonly pref: MdComposePref;
  readonly label: string;
  readonly fullName: string;
  readonly detail: string;
}[] = [
  {
    pref: 'on',
    label: 'Markdown',
    fullName: 'Markdown, Notion-style',
    detail: 'Formats as you type, markers kept faintly visible',
  },
  {
    pref: 'rich',
    label: 'Rich text',
    fullName: 'Rich text',
    detail: 'Formats as you type, markers hidden, with a toolbar; still sends markdown',
  },
  { pref: 'off', label: 'Plain', fullName: 'Plain text box', detail: 'No formatting and no list continuation' },
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
  const style = EDITOR_STYLES.find(entry => entry.pref === pref);
  const layout = DOCK_LAYOUTS.find(entry => entry.value === dockLayout);

  return (
    <>
      <SettingRow
        settingId="composer-markdown"
        name="Editor style"
        hint={style?.detail}
        explanation={
          <>
            <p className="m-0">{settingDefinition('composer-markdown').description}</p>
            <OptionNotes notes={EDITOR_STYLES.map(entry => ({ label: entry.fullName, detail: entry.detail }))} />
            <p className="m-0 mt-2">{MARKDOWN_COMPOSER_EXPLANATION}</p>
          </>
        }
        wide
        control={() => (
          <Segmented
            label="Editor style"
            value={pref}
            options={EDITOR_STYLES.map(entry => ({ id: entry.pref, label: entry.label, title: entry.detail }))}
            onChange={writeMdComposePref}
          />
        )}
      />
      <SettingRow
        name="Button layout"
        hint={layout?.detail}
        explanation={
          <>
            <OptionNotes notes={DOCK_LAYOUTS.map(entry => ({ label: entry.label, detail: entry.detail }))} />
            <p className="m-0 mt-2">{DOCK_LAYOUT_EXPLANATION}</p>
          </>
        }
        wide
        control={() => (
          <Segmented
            label="Button layout"
            value={dockLayout}
            options={DOCK_LAYOUTS.map(entry => ({ id: entry.value, label: entry.label, title: entry.detail }))}
            onChange={writeComposerDockLayout}
          />
        )}
      />
      <SettingRow
        name="Vim-style editing"
        hint="Physical keyboard · NORMAL and INSERT shown under the box"
        explanation={VIM_COMPOSER_EXPLANATION}
        control={labelId => <SettingSwitch checked={vimEnabled} labelledBy={labelId} onChange={onChangeVim} />}
      />
    </>
  );
}
