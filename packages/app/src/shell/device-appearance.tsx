/**
 * SETTINGS › THIS DEVICE › LOOK: colour mode, theme, text size and motion, as v4's Appearance had them — human labels
 * (never a raw id), the theme as a grid of tiles each previewing its family in its own light and dark theme, and the
 * Motion switch that stills every animation. All four are saved in this browser, never on a daemon.
 */
import { type KeyboardEvent, type ReactNode, useCallback, useId, useRef } from 'react';
import { Segmented, SettingGroup, SettingRow } from '../compose/setting-row.tsx';
import type { MotionPreference } from '../compose/controls.ts';
import { useDeviceControls } from '../compose/device-controls.ts';
import type { TextScale } from '../theme/preferences.ts';
import { cn } from '../ui/lib/class-names.ts';
import { MODE_OPTIONS, scrollThemeFamilyIntoView, Swatch } from '../ui/theme-toggle.tsx';
import { type DeviceTheme, useDeviceTheme } from './device-context.tsx';

const TEXT_SCALE_OPTIONS: readonly { readonly id: TextScale; readonly label: string; readonly title: string }[] = [
  { id: 'default', label: 'Default', title: 'Use the interface’s designed size.' },
  { id: 'large', label: 'Large', title: '112% of default.' },
  { id: 'larger', label: 'Larger', title: '125% of default.' },
];

const MOTION_OPTIONS: readonly { readonly id: MotionPreference; readonly label: string; readonly title: string }[] = [
  { id: 'system', label: 'Follow system', title: 'Animations play unless this device asks for less motion.' },
  { id: 'reduced', label: 'Reduced', title: 'Spinners and transitions stay still on this device.' },
];

const MOTION_HINT: Readonly<Record<MotionPreference, string>> = {
  system: 'Follows this device’s reduced-motion setting',
  reduced: 'Spinners and transitions stay still here',
};

/** One width for every control in the Look group, so the three sit in one aligned column at 1280; a phone gives each the full row. */
function EqualWidth({ children }: { readonly children: ReactNode }) {
  return <div className="w-full md:w-72">{children}</div>;
}

/** The theme families as a tile grid: two across on a phone, four on a desktop. Roving radios, like `Segmented`. */
function ThemeTiles({ theme }: { readonly theme: DeviceTheme }) {
  const group = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { families, resolved, setFamily } = theme;
  const family = theme.preference.family;

  const reveal = useCallback((control: HTMLElement) => {
    const card = control.closest<HTMLElement>('[data-family-card]') ?? control;
    const scroller = card.closest<HTMLElement>('[data-settings-scroller]');
    if (scroller) scrollThemeFamilyIntoView(scroller, card);
  }, []);

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
    const control =
      target === undefined ? null : ref.current?.querySelector<HTMLInputElement>(`[data-family="${target.id}"]`);
    if (target === undefined || !control) return;
    setFamily(target.id);
    control.focus({ preventScroll: true });
    reveal(control);
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

/** The Look group. Draws nothing outside an app shell (no device theme to change). */
export function DeviceAppearance() {
  const theme = useDeviceTheme();
  const { device, set } = useDeviceControls();
  if (theme === null) return null;
  const { preference, resolved } = theme;
  const family = theme.families.find(option => option.id === preference.family);
  return (
    <SettingGroup label="Look">
      <SettingRow
        settingId="theme"
        name="Colour mode"
        hint={preference.mode === 'system' ? `Auto follows the system (now ${resolved})` : `Always ${preference.mode}`}
        wide
        control={() => (
          <EqualWidth>
            <Segmented
              fill
              label="Colour mode"
              value={preference.mode}
              options={MODE_OPTIONS.map(({ id, label, hint }) => ({ id, label, title: hint }))}
              onChange={theme.setMode}
            />
          </EqualWidth>
        )}
      />
      <SettingRow name="Theme" hint={family === undefined ? undefined : `${family.label} — ${family.blurb}`}>
        <ThemeTiles theme={theme} />
      </SettingRow>
      <SettingRow
        settingId="text-size"
        name="Text size"
        hint="Touch targets never shrink"
        wide
        control={() => (
          <EqualWidth>
            <Segmented
              fill
              label="Text size"
              value={preference.textScale}
              options={TEXT_SCALE_OPTIONS}
              onChange={theme.setTextScale}
            />
          </EqualWidth>
        )}
      />
      <SettingRow
        settingId="motion"
        name="Motion"
        hint={MOTION_HINT[device.motion]}
        wide
        control={() => (
          <EqualWidth>
            <Segmented
              fill
              label="Motion"
              value={device.motion}
              options={MOTION_OPTIONS}
              onChange={motion => void set({ motion })}
            />
          </EqualWidth>
        )}
      />
    </SettingGroup>
  );
}
