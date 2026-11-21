/**
 * The browser entry for the ONBOARDING APPEARANCE STEP over fake data (no daemon): the REAL `AppearanceChoices` page drawn by the
 * REAL `FlowPage` (cover, frame, footer, demo column) over a stateful fake device theme that lists the shell's real styles and
 * palettes. The shell root publishes the three theme axes on `<html>` when a pick is made; this scene does the same, so a pick
 * restyles the page exactly as it does in the app.
 *
 *   ?theme=<family>-<mode>   the first look (the legacy `data-theme`)
 */
import {
  DEFAULT_THEME_PREFERENCE,
  type DeviceTheme,
  PALETTES,
  STYLES,
  THEME_FAMILIES,
  type ThemePreference,
} from '@ferretry/app';
import { LivingBackground } from '@ferretry/app/ui';
import type { StepHost } from '@ferretry/kernel/contract';
import { type ReactNode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceChoices } from '../../../../app/features/setup-flow/appearance-page.tsx';
import { FlowPage } from '../../../../app/features/setup-flow/page-frame.tsx';
import type { FlowStep } from '../../../../app/lib/index.ts';

const params = new URLSearchParams(window.location.search);
const first = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = first;

const STEP: FlowStep = {
  key: 'onboarding.appearance',
  plugin: 'onboarding',
  id: 'appearance',
  title: 'Appearance',
  phase: 'client',
  order: 90,
  appliesTo: [],
  onlyOn: [],
  stepHost: true,
  state: 'pending',
};
const PROGRESS = {
  segments: [
    { id: 'onboarding', label: 'This machine' },
    { id: 'device', label: 'This device' },
  ],
  current: 'device',
  step: 1,
  of: 4,
  fills: true as const,
};
const noop = (): void => undefined;

/** A device theme that keeps its preference in state and publishes the axes on `<html>` (what the shell root does). */
function useFakeTheme(): DeviceTheme {
  const [preference, setPreference] = useState<ThemePreference>({
    ...DEFAULT_THEME_PREFERENCE,
    mode: first.endsWith('dark') ? 'dark' : 'light',
  });
  const resolved = preference.mode === 'dark' ? 'dark' : 'light';
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.style = preference.style;
    root.dataset.palette = preference.palette;
    root.dataset.mode = resolved;
    root.dataset.theme = `${preference.palette}-${resolved}`;
  }, [preference.style, preference.palette, resolved]);
  return {
    preference,
    resolved,
    families: THEME_FAMILIES,
    styles: STYLES,
    palettes: PALETTES,
    setStyle: style => setPreference(now => ({ ...now, style })),
    setPalette: palette => setPreference(now => ({ ...now, palette })),
    setMode: mode => setPreference(now => ({ ...now, mode })),
    setFamily: () => undefined,
    setKeepPalette: () => undefined,
    setTextScale: () => undefined,
  };
}

function Scene(): ReactNode {
  const theme = useFakeTheme();
  return (
    <FlowPage
      step={STEP}
      daemon="fy_daemon_a"
      progress={PROGRESS}
      direction="forward"
      canBack
      segment={() => ({})}
      remember={noop}
      onDone={noop}
      onSkip={noop}
      onNotNeeded={noop}
      onNext={noop}
      onBack={noop}
      onLater={noop}
      silenceMs={600_000}
      render={(host: StepHost) => <AppearanceChoices theme={theme} step={host} />}
    />
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="fy-sf-root" data-scene-ready="">
      <LivingBackground />
      <div style={{ bottom: 0, display: 'flex', left: 0, position: 'fixed', right: 0, top: 0 }} data-scene-frame="">
        <main
          style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', position: 'relative' }}
          data-scene-main=""
        >
          <Scene />
        </main>
      </div>
    </div>,
  );
