/**
 * The browser entry for the ONBOARDING APPEARANCE STEP over fake data (no daemon): the REAL `createAppearancePanel` (what the
 * setup flow mounts) drawn by the REAL `FlowPage` (cover, frame, footer, demo column) over a REAL device theme store in memory
 * (`WithDeviceTheme`, which publishes the axes on `<html>` as the shell root does), so a pick restyles the page exactly as it
 * does in the app. Nothing here stands in for the panel.
 *
 *   ?theme=<family>-<mode>   the first look (the mode is read from it)
 */
import { LivingBackground } from '@ferretry/app/ui';
import { WithDeviceTheme } from '@ferretry/app/testing/settings-shell';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { FlowPage } from '../../../../app/features/setup-flow/page-frame.tsx';
import { createAppearancePanel } from '../../../../app/features/setup-flow/shell-pages-panels.tsx';
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

const Panel = createAppearancePanel({} as PluginClient);
const mode = first.endsWith('dark') ? 'dark' : 'light';

function Scene(): ReactNode {
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
      render={(host: StepHost) => <Panel step={host} />}
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
          <WithDeviceTheme mode={mode}>
            <Scene />
          </WithDeviceTheme>
        </main>
      </div>
    </div>,
  );
