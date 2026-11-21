/**
 * SETTINGS › THIS DEVICE › LOOK: three choices and one specimen. STYLE (how things are drawn: type, radius, strokes, shadows,
 * spacing, motion) is a row of cards each drawn in its own style; PALETTE (which colours) is a row of two-colour chips;
 * COLOUR MODE is Auto / Light / Dark. Any style takes any palette in either mode. Below them ONE specimen shows every
 * detail of the look in force and replays once on each pick. Text size and Motion follow, as v4 had them. All of it is
 * saved in this browser, never on a daemon. The onboarding appearance page reuses this component, so it moves with it.
 */
import type { ReactNode } from 'react';
import { Segmented, SettingGroup, SettingRow } from '../compose/setting-row.tsx';
import type { MotionPreference } from '../compose/controls.ts';
import { useDeviceControls } from '../compose/device-controls.ts';
import type { TextScale } from '../theme/preferences.ts';
import { MODE_OPTIONS } from '../ui/theme-toggle.tsx';
import { useDeviceTheme } from './device-context.tsx';
import { KeepPaletteSwitch, PalettePicker, StylePicker } from './appearance-pickers.tsx';
import { AppearanceSpecimen } from './appearance-specimen.tsx';
import { ColourModePreview, MotionPreview, TextSizePreview } from './device-appearance-previews.tsx';

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
  return <div className="w-full md:w-72 md:max-w-full">{children}</div>;
}

/** The Look group. Draws nothing outside an app shell (no device theme to change). */
export function DeviceAppearance() {
  const theme = useDeviceTheme();
  const { device, set } = useDeviceControls();
  if (theme === null) return null;
  const { preference, resolved } = theme;
  const style = theme.styles.find(option => option.id === preference.style);
  const palette = theme.palettes.find(option => option.id === preference.palette);
  const look = {
    style: preference.style,
    palette: preference.palette,
    mode: resolved,
    modePreference: preference.mode,
    textScale: preference.textScale,
  };
  return (
    <SettingGroup label="Look">
      <SettingRow
        settingId="theme"
        name="Style"
        hint={style?.label}
        explanation="How the app is drawn: type, corners, borders, shadows, spacing and motion. Each style comes with a palette (the colours shown with it); pick another palette after, or keep yours with the switch. Saved on this device."
      >
        <div className="px-panel pb-3">
          <StylePicker
            styles={theme.styles}
            value={preference.style}
            palette={preference.palette}
            keepPalette={preference.keepPalette}
            mode={resolved}
            onChange={theme.setStyle}
          />
        </div>
        <div className="px-panel pb-3">
          <KeepPaletteSwitch checked={preference.keepPalette} onChange={theme.setKeepPalette} />
        </div>
      </SettingRow>
      <SettingRow
        name="Palette"
        hint={palette?.label}
        explanation="Which colours the app uses. Each chip shows the palette's light half and its dark half, in the style you picked. Saved on this device."
      >
        <div className="px-panel pb-3">
          <PalettePicker
            palettes={theme.palettes}
            value={preference.palette}
            style={preference.style}
            onChange={theme.setPalette}
          />
        </div>
      </SettingRow>
      <SettingRow
        preview={<ColourModePreview look={preference} mode={preference.mode} />}
        name="Colour mode"
        explanation="Auto follows this device's light or dark setting; Light and Dark stay as you choose. Saved on this device."
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
      <SettingRow
        name="Specimen"
        hint="Every detail of your look, in one place"
        explanation="Type and weights, buttons at rest, hover and press, an input with its keyboard focus ring, a panel and its shadow, corners and borders, spacing, a toggle and a list row. It plays once each time you change something."
      >
        <div className="px-panel pb-3">
          <AppearanceSpecimen look={look} />
        </div>
      </SettingRow>
      <SettingRow
        settingId="text-size"
        preview={<TextSizePreview scale={preference.textScale} />}
        name="Text size"
        hint="Touch targets never shrink"
        explanation="Scales the text across the app on this device. Buttons and touch targets keep their size, so nothing gets harder to tap."
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
        preview={<MotionPreview motion={device.motion} />}
        name="Motion"
        hint={MOTION_HINT[device.motion]}
        explanation="Reduced stills spinners and transitions on this device. Follow system plays animations unless this device asks for less motion."
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
