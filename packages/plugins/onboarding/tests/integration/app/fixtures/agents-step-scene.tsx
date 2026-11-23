/**
 * The browser entry for the ONBOARDING "WHICH AI DO YOU WANT TO USE?" STEP over fake data (no daemon): the REAL `createAgentsPanel`
 * (what the setup flow mounts) drawn by the REAL `FlowPage` (cover, frame, footer). The one fake is the client, whose
 * `GET /v1/logins/presets` answers the REAL provider catalog (Logins' `REAL_PROVIDER_PRESET_CATALOG`, held to the service by Logins' own test: what the shipped built-in
 * presets say, with the harness ids the wire carries).
 *
 *   ?theme=<family>-<mode>   the first look (the mode is read from it)
 */
import { LivingBackground } from '@ferretry/app/ui';
import { WithDeviceTheme } from '@ferretry/app/testing/settings-shell';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentsPanel } from '../../../../app/features/agents/agents-panel.tsx';
import { FlowPage } from '../../../../app/features/setup-flow/page-frame.tsx';
import type { FlowStep } from '../../../../app/lib/index.ts';
import { REAL_PROVIDER_PRESET_CATALOG as PROVIDER_PRESETS } from '@ferretry/plugin-logins/contract/testing';

const params = new URLSearchParams(window.location.search);
const first = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = first;

const client = {
  call: async (route: string) => {
    if (route === 'GET /v1/logins/presets') return PROVIDER_PRESETS;
    throw new Error(`unexpected route ${route}`);
  },
} as unknown as PluginClient;

const STEP: FlowStep = {
  key: 'onboarding.agents',
  plugin: 'onboarding',
  id: 'agents',
  title: 'Which AI do you want to use?',
  phase: 'daemon',
  order: 2,
  appliesTo: [],
  onlyOn: [],
  stepHost: true,
  state: 'pending',
};
const PROGRESS = {
  segments: [
    { id: 'onboarding', label: 'This machine' },
    { id: 'claude-code', label: 'Claude Code' },
  ],
  current: 'onboarding',
  step: 1,
  of: 2,
  fills: true as const,
};
const noop = (): void => undefined;

const Panel = createAgentsPanel(client);
const mode = first.endsWith('dark') ? 'dark' : 'light';

function Scene(): ReactNode {
  return (
    <FlowPage
      step={STEP}
      daemon="fy_daemon_a"
      progress={PROGRESS}
      direction="forward"
      canBack={false}
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
