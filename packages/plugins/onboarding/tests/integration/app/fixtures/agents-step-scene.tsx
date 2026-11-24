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
import { type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { hostScan } from '../../../fixtures/host-scan.ts';
import { createAgentsPanel } from '../../../../app/features/agents/agents-panel.tsx';
import { readSetupScanAhead, useScan } from '../../../../app/features/setup-flow/machine-scan.ts';
import { FlowPage } from '../../../../app/features/setup-flow/page-frame.tsx';
import type { FlowStep } from '../../../../app/lib/index.ts';
import { REAL_PROVIDER_PRESET_CATALOG as PROVIDER_PRESETS } from '@ferretry/plugin-logins/contract/testing';

const params = new URLSearchParams(window.location.search);
const first = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = first;
// `?claude=absent`: the fake machine has no Claude Code. `window.__scanCalls`: how many times the page asked the machine to scan.
const installed = params.get('claude') !== 'absent';
// `?scan=fail`: the machine refuses its scan, so the flow's read ahead fails before the picker mounts. Then a second page (the
// Settings import's scan reader) and the picker can be swapped with `[data-scene-to-reader]` / `[data-scene-to-picker]`.
const scanFails = params.get('scan') === 'fail';
// `?third=1`: the machine's registry lists a third harness (a plugin this page has never heard of), registered FIRST.
const HARNESSES = [
  ...(params.get('third') === '1' ? [{ key: 'fake-third', label: 'Fake Third' }] : []),
  { key: 'codex', label: 'Codex' },
  { key: 'claude-code', label: 'Claude Code' },
];
const counted = window as unknown as { __scanCalls: number };
counted.__scanCalls = 0;

const client = {
  call: async (route: string) => {
    if (route === 'GET /v1/logins/presets') return PROVIDER_PRESETS;
    if (route === 'GET /v1/onboarding') return { harnesses: HARNESSES };
    if (route === 'GET /v1/runtimes/setup/scan') {
      counted.__scanCalls += 1;
      if (scanFails) throw new Error('the scan was refused');
      return hostScan(installed);
    }
    if (route === 'GET /v1/claude-code/update') return { installed: { state: 'ok', version: '2.1.0' } };
    if (route === 'GET /v1/codex/update') return { installed: null };
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
  pages: true as const,
};
const noop = (): void => undefined;

// The setup flow starts the machine's scan the moment it opens (`useSetupFlow`); the picker only reads that read.
readSetupScanAhead(client);
const Panel = createAgentsPanel(client);
const mode = first.endsWith('dark') ? 'dark' : 'light';

/** Another reader of the machine's scan, as the real Claude import Settings page is (it reads the machine afresh). */
function ScanReader(): ReactNode {
  useScan(client, { run: 'settings-import', refresh: true });
  return <p data-scene-reader="">The import page, reading the machine.</p>;
}

function Scene(): ReactNode {
  const [onReader, setOnReader] = useState(false);
  if (onReader)
    return (
      <div>
        <ScanReader />
        <button type="button" data-scene-to-picker="" onClick={() => setOnReader(false)}>
          Back to the picker
        </button>
      </div>
    );
  return (
    <>
      {scanFails ? (
        <button type="button" data-scene-to-reader="" onClick={() => setOnReader(true)}>
          Open the import page
        </button>
      ) : null}
      <Picker />
    </>
  );
}

function Picker(): ReactNode {
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
