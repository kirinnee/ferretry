/**
 * The browser entry for the SETUP FLOW over FAKE data (no daemon): the REAL `FlowPage` (loading cover, frame, footer,
 * "Only on" chip, Later) and the REAL `EndPage`, with a fake plugin page drawn through `render`. The living background
 * is the flow screen's own.
 *
 *   ?theme=<family>-<mode>
 *   ?case=loading|silent|choice|chip|busy|transition|end
 *            loading = the page has not said ready (the cover); silent = 10 s of silence (Skip this step); choice = a
 *            fake page with three choice cards; chip = the same on a page only one machine carries; busy = a long act
 *            (Next locked); transition = the choice page frozen mid slide-in; end = the last page
 */
import { LivingBackground } from '@ferretry/app/ui';
import { ChoiceCards } from '@ferretry/app';
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { EndPage } from '../../../../app/features/setup-flow/end-page.tsx';
import { FlowPage } from '../../../../app/features/setup-flow/page-frame.tsx';
import type { FlowStep } from '../../../../app/lib/index.ts';
import type { StepHost } from '@ferretry/kernel/contract';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'choice';

const STEP: FlowStep = {
  key: 'fake-pack.choose',
  plugin: 'fake-pack',
  id: 'choose',
  title: 'How should it import?',
  phase: 'daemon',
  order: 21,
  appliesTo: [{ daemon: 'fy_daemon_a', name: 'studio-box' }],
  onlyOn: scene === 'chip' ? ['studio-box'] : [],
  state: 'pending',
};
const PROGRESS = {
  segments: [
    { id: 'onboarding', label: 'This machine' },
    { id: 'fake-pack', label: 'Fake Pack' },
    { id: 'codex', label: 'Codex' },
    { id: 'device', label: 'This device' },
  ],
  current: 'fake-pack',
  step: 2,
  of: 3,
};

function Choice({ host }: { readonly host: StepHost }): ReactNode {
  const [value, setValue] = useState<string | null>('everything');
  useEffect(() => host.ready(), [host]);
  return (
    <ChoiceCards
      label="Import"
      value={value}
      onChange={setValue}
      options={[
        {
          id: 'everything',
          title: 'Import everything',
          line: 'Settings, skills, MCP servers and CLAUDE.md in one go.',
        },
        { id: 'choose', title: 'Let me choose', line: 'One page for each kind.' },
        { id: 'nothing', title: 'Start fresh', line: 'Nothing is copied.' },
      ]}
    />
  );
}
const Quiet = (): ReactNode => <p>Fake page that has not answered yet.</p>;
function Busy({ host }: { readonly host: StepHost }): ReactNode {
  useEffect(() => {
    host.ready();
    host.busy('Installing Claude Code…');
  }, [host]);
  return <p>Installing…</p>;
}

const noop = (): void => undefined;
const common = {
  step: STEP,
  daemon: 'fy_daemon_a',
  progress: PROGRESS,
  direction: 'forward' as const,
  canBack: true,
  segment: () => ({}),
  remember: noop,
  onDone: noop,
  onSkip: noop,
  onNext: noop,
  onBack: noop,
  onLater: noop,
};

function Scene(): ReactNode {
  if (scene === 'end')
    return (
      <EndPage
        daemon="fy_daemon_a"
        onBack={noop}
        summary={[
          { plugin: 'onboarding', id: 'name', title: 'Name this machine', state: 'done' },
          { plugin: 'fake-pack', id: 'choose', title: 'How should it import?', state: 'done' },
          { plugin: 'warden', id: 'warden', title: 'Warden', state: 'later' },
        ]}
      />
    );
  const render =
    scene === 'loading' || scene === 'silent'
      ? () => <Quiet />
      : scene === 'busy'
        ? (host: StepHost) => <Busy host={host} />
        : (host: StepHost) => <Choice host={host} />;
  return <FlowPage {...common} render={render} silenceMs={scene === 'silent' ? 30 : 600_000} />;
}

// A frame frozen mid slide-in, for the transition shot.
if (scene === 'transition') {
  const style = document.createElement('style');
  style.textContent = '.fy-sf-page{animation-play-state:paused!important;animation-delay:-90ms!important}';
  document.head.append(style);
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="fy-sf-root" data-scene-ready="">
      <LivingBackground />
      <Scene />
    </div>,
  );
