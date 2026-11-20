/**
 * Settings › Appearance as two compact groups of rows: LOOK (colour mode, theme, text size, motion) and
 * LAYOUT (density, conversation width, Needs you, links, message marks).
 *
 * Each row writes the same preference the old big card did; only the layout changed. The long
 * explanations are the settings' catalog descriptions, now behind each row's (i). The theme picker here is
 * a tile grid; the top bar's popover keeps its own list (`shell/theme-toggle.tsx`) and both write
 * through the same `ThemeState`.
 */

import { type KeyboardEvent, useCallback, useEffect, useId, useRef } from 'react';
import { DENSITY_OPTIONS, type useDensity } from '../../hooks/use-density.ts';
import type { ThemeState } from '../../hooks/use-theme.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonControlsStore, DeviceControls, MotionPreference, OpenLinksIn } from '../../lib/controls.ts';
import { OPEN_LINKS_IN } from '../../lib/controls.ts';
import { bundledEmbedKey, GOOGLE_MAPS_PRIVACY_NOTE, type MapStyle } from '../../lib/map-style.ts';
import type { ChatWidth } from '../../shell/chat-width-control.tsx';
import { ACTIVE_EXPLANATION, CHAT_WIDTH_OPTIONS } from '../../shell/chat-width-control.tsx';
import { MODE_OPTIONS, Swatch, scrollThemeFamilyIntoView } from '../../shell/theme-toggle.tsx';
import { MessageMarksLegend } from './message-marks-legend.tsx';
import { Segmented, SettingDisclosureRow, SettingGroup, SettingRow, SettingSwitch } from './setting-row.tsx';
import { settingDefinition } from './settings-catalog.ts';

const TEXT_SCALE_OPTIONS = [
  { id: 'default', label: 'Default', description: 'Use the interface’s designed size.' },
  { id: 'large', label: 'Large', description: '112% of default.' },
  { id: 'larger', label: 'Larger', description: '125% of default.' },
] as const;

const MOTIONS: readonly { readonly id: MotionPreference; readonly label: string; readonly detail: string }[] = [
  { id: 'system', label: 'Follow system', detail: 'Animations play unless this device asks for less motion.' },
  { id: 'reduced', label: 'Reduced', detail: 'Spinners and transitions stay still on this device.' },
];

const MOTION_HINT: Readonly<Record<MotionPreference, string>> = {
  system: 'Follows this device’s reduced-motion setting',
  reduced: 'Spinners and transitions stay still here',
};

const WIDTH_HINT: Readonly<Record<ChatWidth, string>> = {
  readable: '720px column, centred',
  balanced: '1200px column',
  full: 'The whole conversation pane',
};

const OPEN_LINK_LABEL: Readonly<Record<OpenLinksIn, string>> = {
  browser: 'Your browser',
  panel: 'Ferretry side panel',
  computer: "Your computer's default browser",
};

const MAP_STYLE_OPTIONS: readonly { readonly id: MapStyle; readonly label: string }[] = [
  { id: 'osm', label: 'OpenStreetMap' },
  { id: 'google', label: 'Google Maps' },
];

const COMPUTER_LINKS_NOTE =
  "Your computer's default browser opens links in whichever browser this computer picks, so a link router can choose the profile.";

/** The sentence each choice carries, one per line, so the (i) says what every option does and not only the chosen one. */
function OptionNotes({ notes }: { readonly notes: readonly (readonly [label: string, text: string])[] }) {
  return (
    <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0" data-option-notes="">
      {notes.map(([label, text]) => (
        <li key={label}>
          <span className="font-semibold text-fg">{label}</span> — {text}
        </li>
      ))}
    </ul>
  );
}

/** A row's (i): its lead sentence, then what each of its options does. */
function Explained({
  lead,
  notes,
}: {
  readonly lead: string;
  readonly notes: readonly (readonly [label: string, text: string])[];
}) {
  return (
    <>
      <p className="m-0">{lead}</p>
      <OptionNotes notes={notes} />
    </>
  );
}

const described = (id: Parameters<typeof settingDefinition>[0], extra?: string): string =>
  extra === undefined ? settingDefinition(id).description : `${settingDefinition(id).description} ${extra}`;

/** The theme families as a tile grid: two across on a phone, four on a desktop. Roving radios, like `Segmented`. */
function ThemeTiles({ theme }: { readonly theme: ThemeState }) {
  const group = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { family, resolved, families, setFamily } = theme;

  // The radio is `sr-only` and has no box of its own; the CARD around it is what the reader is looking for.
  // Scoped to the Settings scroller: `scrollIntoView()` would also scroll the app's overflow-hidden shell.
  const revealFamily = useCallback((control: HTMLElement) => {
    const card = control.closest<HTMLElement>('[data-family-card]') ?? control;
    const scroller = card.closest<HTMLElement>('[data-settings-scroller]');
    if (scroller) scrollThemeFamilyIntoView(scroller, card);
  }, []);

  // Changing family also changes fonts and spacing. Recheck on the next frame, after `useTheme` has published
  // the new root data-theme, so a card aligned to the old geometry cannot slip back under the scroller's edge.
  useEffect(() => {
    const target = ref.current?.querySelector<HTMLInputElement>(`[data-family="${family}"]`);
    if (!target || document.activeElement !== target) return;
    const frame = requestAnimationFrame(() => {
      if (target.isConnected && document.activeElement === target) revealFamily(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [family, revealFamily]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = families.findIndex(option => option.id === family);
    const last = families.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? Math.min(last, index + 1)
            : Math.max(0, index - 1);
    const target = families[next];
    if (target === undefined) return;
    setFamily(target.id);
    const control = ref.current?.querySelector<HTMLInputElement>(`[data-family="${target.id}"]`);
    if (control === null || control === undefined) return;
    // Own the scroll: focus without scrolling, then reveal the card inside the Settings scroller.
    control.focus({ preventScroll: true });
    revealFamily(control);
  };
  return (
    // `relative` is load-bearing: the radios are `sr-only` (absolute) and must stay inside the page's scroller.
    <div
      ref={ref}
      role="radiogroup"
      aria-label="Theme family"
      onKeyDown={onKeyDown}
      className="relative grid grid-cols-2 gap-1.5 px-panel pb-3 md:grid-cols-4"
      data-theme-tiles=""
    >
      {families.map(option => {
        const checked = option.id === family;
        return (
          <label
            key={option.id}
            data-family-card={option.id}
            className={cn(
              'flex min-h-[44px] min-w-0 cursor-pointer flex-col gap-1 rounded-control border p-2 text-left transition-colors',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
              checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent',
            )}
          >
            <input
              type="radio"
              name={`${group}-family`}
              data-family={option.id}
              value={option.id}
              checked={checked}
              aria-label={`${option.label} — ${option.blurb}`}
              tabIndex={checked ? 0 : -1}
              onChange={() => setFamily(option.id)}
              className="sr-only"
            />
            <span className="truncate text-meta font-semibold text-fg">{option.label}</span>
            <span className="flex items-stretch gap-1">
              <Swatch theme={`${option.id}-light`} current={checked && resolved === 'light'} />
              <Swatch theme={`${option.id}-dark`} current={checked && resolved === 'dark'} />
            </span>
          </label>
        );
      })}
    </div>
  );
}

export interface AppearanceGroupsProps {
  readonly theme: ThemeState;
  readonly densityState: ReturnType<typeof useDensity>;
  readonly device: DeviceControls;
  readonly computerAvailable: boolean;
  readonly controls: DaemonControlsStore;
  /** Whether this build carries the Ferretry Google Maps key. Without it the Map style row is not shown at all. */
  readonly googleMapsAvailable?: boolean;
}

export function AppearanceGroups({
  theme,
  densityState,
  device,
  computerAvailable,
  controls,
  googleMapsAvailable = bundledEmbedKey() !== null,
}: AppearanceGroupsProps) {
  const set = (patch: Partial<DeviceControls>): void => {
    controls.setDeviceControls(patch);
  };
  const family = theme.families.find(option => option.id === theme.family);
  const densityOption = DENSITY_OPTIONS.find(option => option.id === densityState.density);
  // A saved "computer" with no local daemon behaves as the browser does, so that is what is shown selected.
  const links = device.openLinksIn === 'computer' && !computerAvailable ? 'browser' : device.openLinksIn;
  const linkOptions = OPEN_LINKS_IN.filter(value => value !== 'computer' || computerAvailable).map(id => ({
    id,
    label: OPEN_LINK_LABEL[id],
  }));
  return (
    <>
      <SettingGroup label="Look">
        <SettingRow
          settingId="theme"
          name="Colour mode"
          hint={theme.mode === 'system' ? `Auto follows the system (now ${theme.resolved})` : `Always ${theme.mode}`}
          explanation={
            <Explained
              lead={`${described('theme')} Previews render in their own theme. Auto follows the OS live.`}
              notes={MODE_OPTIONS.map(option => [option.label, option.hint] as const)}
            />
          }
          wide
          control={() => (
            <Segmented
              label="Colour mode"
              value={theme.mode}
              options={MODE_OPTIONS.map(({ id, label, hint }) => ({ id, label, title: hint }))}
              onChange={theme.setMode}
            />
          )}
        />
        <SettingRow
          name="Theme"
          hint={family === undefined ? undefined : `${family.label} — ${family.blurb}`}
          explanation={
            <Explained
              lead="Each tile previews its family in its own light and dark theme."
              notes={theme.families.map(option => [option.label, option.blurb] as const)}
            />
          }
        >
          <ThemeTiles theme={theme} />
        </SettingRow>
        <SettingRow
          settingId="text-size"
          name="Text size"
          hint="Touch targets never shrink"
          explanation={
            <Explained
              lead={described(
                'text-size',
                'Sizes never go below Default, so existing 44px touch targets are not reduced.',
              )}
              notes={TEXT_SCALE_OPTIONS.map(option => [option.label, option.description] as const)}
            />
          }
          wide
          control={() => (
            <Segmented
              label="Text size"
              value={theme.textScale}
              options={TEXT_SCALE_OPTIONS}
              onChange={theme.setTextScale}
            />
          )}
        />
        <SettingRow
          settingId="motion"
          name="Motion"
          hint={MOTION_HINT[device.motion]}
          explanation={
            <Explained
              lead={described('motion')}
              notes={MOTIONS.map(option => [option.label, option.detail] as const)}
            />
          }
          wide
          control={() => (
            <Segmented label="Motion" value={device.motion} options={MOTIONS} onChange={motion => set({ motion })} />
          )}
        />
      </SettingGroup>

      <SettingGroup label="Layout">
        <SettingRow
          settingId="density"
          name="Density"
          hint={
            densityState.explicit === null
              ? `Device default: ${densityOption?.label ?? densityState.density}`
              : (densityOption?.description ?? '')
          }
          explanation={
            <Explained
              lead={described(
                'density',
                'Using the device default until you pick a level; picking one saves an explicit choice.',
              )}
              notes={DENSITY_OPTIONS.map(option => [option.label, option.description] as const)}
            />
          }
          wide
          control={() => (
            <Segmented
              label="Dashboard density"
              value={densityState.density}
              options={DENSITY_OPTIONS}
              onChange={densityState.setDensity}
            />
          )}
        />
        <SettingRow
          settingId="chat-width"
          name="Conversation width"
          hint={WIDTH_HINT[device.chatWidth]}
          explanation={
            <Explained
              lead={`${described('chat-width')} ${ACTIVE_EXPLANATION[device.chatWidth]} In a pane narrower than the column — a phone, or beside a split pane — the choices look the same.`}
              notes={CHAT_WIDTH_OPTIONS.map(option => [option.label, option.description] as const)}
            />
          }
          wide
          control={() => (
            <Segmented
              label="Conversation width"
              value={device.chatWidth}
              options={CHAT_WIDTH_OPTIONS}
              onChange={chatWidth => set({ chatWidth })}
            />
          )}
        />
        <SettingRow
          settingId="group-needs-you"
          name="Group Needs you at the top"
          hint="Sessions with open Inbox items go first"
          explanation={described(
            'group-needs-you',
            'Off keeps those sessions in their project group, with just the Inbox badge.',
          )}
          control={labelId => (
            <SettingSwitch
              checked={device.groupNeedsYou}
              labelledBy={labelId}
              onChange={groupNeedsYou => set({ groupNeedsYou })}
            />
          )}
        />
        <SettingRow
          settingId="open-links-in"
          name="Open links in"
          hint="Cmd/Ctrl-click always opens a new tab"
          explanation={
            computerAvailable ? `${described('open-links-in')} ${COMPUTER_LINKS_NOTE}` : described('open-links-in')
          }
          wide
          control={() => (
            <Segmented
              label="Open links in"
              value={links}
              options={linkOptions}
              onChange={openLinksIn => set({ openLinksIn })}
            />
          )}
        />
        {googleMapsAvailable ? (
          <SettingRow
            settingId="map-style"
            name="Map style"
            hint={GOOGLE_MAPS_PRIVACY_NOTE}
            explanation={`${described('map-style')} Choosing Google Maps tells Google which places you open (OpenStreetMap's tile server sees the area too, and your IP address, as it always has). Saved on this device only.`}
            wide
            control={() => (
              <Segmented
                label="Map style"
                value={device.mapStyle}
                options={MAP_STYLE_OPTIONS}
                onChange={mapStyle => set({ mapStyle })}
              />
            )}
          />
        ) : null}
        <SettingDisclosureRow settingId="message-marks" name="Message marks" hint="What the clock, ticks and ! mean">
          <MessageMarksLegend />
        </SettingDisclosureRow>
      </SettingGroup>
    </>
  );
}
