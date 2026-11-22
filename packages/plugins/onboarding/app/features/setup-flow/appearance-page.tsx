/**
 * THE APPEARANCE STEP (r11 G2, C59 O6): first run's client page about how this device looks, in THREE groups in the order a
 * person decides them: STYLE, then COLOUR (the palette and light/dark together), then SIZE AND MOTION (text size and motion
 * together). Each list is short stacked cards (titles only, nothing to read) and ONE live picture sits on the right
 * (`StepDemo`: a small app window drawn from the page's own tokens, so it IS the look in force: colours, style, text size and
 * motion), which pops once when a pick is made.
 *
 * A pick is applied and saved in this browser at once (the shell's `useDeviceTheme`, the same store Settings › Appearance
 * writes), so there is nothing for Next to save and no per-pick `done()`. The page draws no title, footer or loader: the setup
 * flow owns them. Outside an app shell there is no device theme to change, so the page draws nothing.
 */
import {
  ChoiceCards,
  type DeviceControls,
  type DeviceTheme,
  StepDemo,
  useDeviceControls,
  useDeviceTheme,
} from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AppearanceDemo } from './appearance-demo.tsx';
import './appearance-page.css';

const MODES: readonly { readonly id: 'system' | 'light' | 'dark'; readonly title: string }[] = [
  { id: 'system', title: 'Auto' },
  { id: 'light', title: 'Light' },
  { id: 'dark', title: 'Dark' },
];

const TEXT_SIZES: readonly { readonly id: DeviceTheme['preference']['textScale']; readonly title: string }[] = [
  { id: 'default', title: 'Default' },
  { id: 'large', title: 'Large' },
  { id: 'larger', title: 'Larger' },
];

const MOTIONS: readonly { readonly id: DeviceControls['motion']; readonly title: string }[] = [
  { id: 'system', title: 'Follow system' },
  { id: 'reduced', title: 'Reduced' },
];

/** The page itself over the theme and the motion choice it is handed (the real page hands the device's). */
export function AppearanceChoices({
  theme,
  motion,
  setMotion,
  step,
}: {
  readonly theme: DeviceTheme | null;
  readonly motion: DeviceControls['motion'];
  readonly setMotion: (motion: DeviceControls['motion']) => void;
  readonly step: StepHost | undefined;
}): ReactNode {
  const host = useRef(step);
  host.current = step;
  useEffect(() => host.current?.ready(), []);
  // How many picks have been made: the demo pops once for each (never on mount).
  const [picks, setPicks] = useState(0);
  if (theme === null) return null;
  const picked = <Id extends string>(apply: (id: Id) => void) => {
    return (id: string): void => {
      apply(id as Id);
      setPicks(count => count + 1);
    };
  };
  const { preference } = theme;
  return (
    <div className="fy-astep" data-appearance-step="">
      {/* 1. STYLE: how things are drawn. */}
      <section className="fy-astep__group" data-appearance-group="style" aria-labelledby="fy-astep-style">
        <h2 id="fy-astep-style" className="fy-astep__name">
          Style
        </h2>
        <ChoiceCards
          label="Style"
          layout="stack"
          value={preference.style}
          onChange={picked(theme.setStyle as (id: string) => void)}
          options={theme.styles.map(style => ({ id: style.id, title: style.label }))}
        />
      </section>
      {/* 2. COLOUR: the palette and light or dark, together. */}
      <section className="fy-astep__group" data-appearance-group="colour" aria-labelledby="fy-astep-colour">
        <h2 id="fy-astep-colour" className="fy-astep__name">
          Colour
        </h2>
        <div className="fy-astep__pair">
          <div className="fy-astep__list">
            <h3 id="fy-astep-palette" className="fy-astep__sub">
              Palette
            </h3>
            <ChoiceCards
              label="Palette"
              layout="stack"
              value={preference.palette}
              onChange={picked(theme.setPalette as (id: string) => void)}
              options={theme.palettes.map(palette => ({ id: palette.id, title: palette.label }))}
            />
          </div>
          <div className="fy-astep__list">
            <h3 id="fy-astep-mode" className="fy-astep__sub">
              Light or dark
            </h3>
            <ChoiceCards
              label="Light or dark"
              layout="stack"
              value={preference.mode}
              onChange={picked(theme.setMode as (id: string) => void)}
              options={MODES.map(mode => ({ id: mode.id, title: mode.title }))}
            />
          </div>
        </div>
      </section>
      {/* 3. SIZE AND MOTION: text size and motion, together. */}
      <section className="fy-astep__group" data-appearance-group="comfort" aria-labelledby="fy-astep-comfort">
        <h2 id="fy-astep-comfort" className="fy-astep__name">
          Size and motion
        </h2>
        <div className="fy-astep__pair">
          <div className="fy-astep__list">
            <h3 id="fy-astep-text" className="fy-astep__sub">
              Text size
            </h3>
            <ChoiceCards
              label="Text size"
              layout="stack"
              value={preference.textScale}
              onChange={picked(theme.setTextScale as (id: string) => void)}
              options={TEXT_SIZES.map(size => ({ id: size.id, title: size.title }))}
            />
          </div>
          <div className="fy-astep__list">
            <h3 id="fy-astep-motion" className="fy-astep__sub">
              Motion
            </h3>
            <ChoiceCards
              label="Motion"
              layout="stack"
              value={motion}
              onChange={picked(setMotion as (id: string) => void)}
              options={MOTIONS.map(option => ({ id: option.id, title: option.title }))}
            />
          </div>
        </div>
      </section>
      <p className="fy-astep__note">This device only.</p>
      <StepDemo>
        <AppearanceDemo picks={picks} />
      </StepDemo>
    </div>
  );
}

/** The onboarding step's page: the device's own theme, the page's host. */
export function AppearancePage({ step }: { readonly step: StepHost | undefined }): ReactNode {
  const theme = useDeviceTheme();
  const { device, set } = useDeviceControls();
  return (
    <AppearanceChoices theme={theme} motion={device.motion} setMotion={motion => void set({ motion })} step={step} />
  );
}
