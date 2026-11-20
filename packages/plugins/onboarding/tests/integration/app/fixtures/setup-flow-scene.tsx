/**
 * The browser entry for the SETUP FLOW over FAKE data (no daemon): the REAL `FlowPage` (loading cover, frame, footer,
 * "Only on" chip, Later) and the REAL `EndPage`, with a fake plugin page drawn through `render`. The living background
 * is the flow screen's own.
 *
 *   ?theme=<family>-<mode>
 *   ?case=loading|silent|choice|chip|busy|transition|end|legacy|unsaved|end-unsaved|mid|tall
 *            loading = the page has not said ready (the cover); silent = 10 s of silence (Skip this step); choice = a
 *            fake page with three choice cards; chip = the same on a page only one machine carries; busy = a long act
 *            (the whole footer locked); transition = the choice page frozen mid slide-in; end = the last page;
 *            legacy = a page not yet written against StepHost (no cover, Next enabled); unsaved = a page with two
 *            answers the machine did not take; end-unsaved = the last page naming the answers that were not saved;
 *            mid / tall = a page a little under / far over one screen of content (560px / 1600px of cards), drawn INSIDE a
 *            scroll box like the real shell's chrome-less `.fy-main` (the flow is scrolled by that box, not by the document)
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
  stepHost: scene !== 'legacy',
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
/** A page of `height` px of cards, the last one marked `data-last-content` (the test reads where it ends). */
function Cards({ host, height }: { readonly host: StepHost; readonly height: number }): ReactNode {
  useEffect(() => host.ready(), [host]);
  const count = Math.round(height / 112);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Array.from({ length: count }, (_, index) => `card-${index + 1}`).map((id, index) => (
        <div
          key={id}
          style={{ border: '1px solid var(--border)', borderRadius: 12, height: 100, padding: 12 }}
          {...(index === count - 1 ? { 'data-last-content': '' } : {})}
        >
          {id}
        </div>
      ))}
    </div>
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
  onNotNeeded: noop,
  onNext: noop,
  onBack: noop,
  onLater: noop,
};

function Scene(): ReactNode {
  if (scene === 'end' || scene === 'end-unsaved')
    return (
      <EndPage
        daemon="fy_daemon_a"
        onBack={noop}
        onRetry={noop}
        unsaved={
          scene === 'end'
            ? []
            : [
                { step: { ...STEP, key: 'onboarding.name', title: 'Name this machine' }, state: 'done' },
                { step: { ...STEP, key: 'warden.warden', title: 'Warden' }, state: 'later' },
              ]
        }
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
        : scene === 'mid' || scene === 'tall'
          ? (host: StepHost) => <Cards host={host} height={scene === 'mid' ? 560 : 1_600} />
          : scene === 'legacy'
            ? () => <p>A page that has not been moved to the step host yet.</p>
            : (host: StepHost) => <Choice host={host} />;
  return (
    <FlowPage
      {...common}
      render={render}
      silenceMs={scene === 'silent' ? 30 : 600_000}
      {...(scene === 'unsaved' ? { unsaved: { count: 2, retry: noop } } : {})}
    />
  );
}

// A frame frozen mid slide-in, for the transition shot.
if (scene === 'transition') {
  const style = document.createElement('style');
  style.textContent = '.fy-sf-page{animation-play-state:paused!important;animation-delay:-90ms!important}';
  document.head.append(style);
}

const root = document.getElementById('root');
/** The real shell draws a chrome-less screen inside `.fy-frame > .fy-main` (a fixed box whose main area scrolls, no padding). */
const inShell = scene === 'mid' || scene === 'tall';
const flow = (
  <div className="fy-sf-root" data-scene-ready="">
    <LivingBackground />
    <Scene />
  </div>
);
if (root !== null)
  createRoot(root).render(
    inShell ? (
      <div style={{ bottom: 0, display: 'flex', left: 0, position: 'fixed', right: 0, top: 0 }} data-scene-frame="">
        <main
          style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', position: 'relative' }}
          data-scene-main=""
        >
          {flow}
        </main>
      </div>
    ) : (
      flow
    ),
  );
