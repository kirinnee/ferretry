/**
 * THE APPEARANCE STEP (r11 G2): first run's client page about how this device looks. Three short STACKED lists on the left
 * (colour mode, palette, style: card titles only, nothing to read) and ONE live picture on the right (`StepDemo`: a small
 * app window drawn from the page's own tokens, so it IS the look in force), which pops once when a pick is made.
 *
 * A pick is applied and saved in this browser at once (the shell's `useDeviceTheme`, the same store Settings › Appearance
 * writes), so there is nothing for Next to save and no per-pick `done()`. The page draws no title, footer or loader: the setup
 * flow owns them. Outside an app shell there is no device theme to change, so the page draws nothing.
 */
import { ChoiceCards, type DeviceTheme, StepDemo, useDeviceTheme } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AppearanceDemo } from './appearance-demo.tsx';
import './appearance-page.css';

const MODES: readonly { readonly id: 'system' | 'light' | 'dark'; readonly title: string; readonly line: string }[] = [
  { id: 'system', title: 'Auto', line: 'Follows your device' },
  { id: 'light', title: 'Light', line: 'Always light' },
  { id: 'dark', title: 'Dark', line: 'Always dark' },
];

/** The page itself over a theme it is handed (a scene hands a fake one; the real page hands the device's). */
export function AppearanceChoices({
  theme,
  step,
}: {
  readonly theme: DeviceTheme | null;
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
      <section className="fy-astep__row" aria-labelledby="fy-astep-mode">
        <h2 id="fy-astep-mode" className="fy-astep__name">
          Colour mode
        </h2>
        <ChoiceCards
          label="Colour mode"
          layout="stack"
          value={preference.mode}
          onChange={picked(theme.setMode as (id: string) => void)}
          options={MODES.map(mode => ({ id: mode.id, title: mode.title, line: mode.line }))}
        />
      </section>
      <section className="fy-astep__row" aria-labelledby="fy-astep-palette">
        <h2 id="fy-astep-palette" className="fy-astep__name">
          Palette
        </h2>
        <ChoiceCards
          label="Palette"
          layout="stack"
          value={preference.palette}
          onChange={picked(theme.setPalette as (id: string) => void)}
          options={theme.palettes.map(palette => ({ id: palette.id, title: palette.label }))}
        />
      </section>
      <section className="fy-astep__row" aria-labelledby="fy-astep-style">
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
      <p className="fy-astep__note">This device only.</p>
      <StepDemo>
        <AppearanceDemo picks={picks} />
      </StepDemo>
    </div>
  );
}

/** The onboarding step's page: the device's own theme, the page's host. */
export function AppearancePage({ step }: { readonly step: StepHost | undefined }): ReactNode {
  return <AppearanceChoices theme={useDeviceTheme()} step={step} />;
}
