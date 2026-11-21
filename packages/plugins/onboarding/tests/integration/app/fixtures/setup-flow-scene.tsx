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
 *   r11 O1 (`StepHost.commit` and the 300 ms cover), each a two-page wizard whose first page is the one named:
 *   ?case=commit      a page that registers a save; `window.__saves` counts how often Next ran it
 *   ?case=commit-fail the same, but the FIRST save rejects with an Error (the page stays, the message shows, Next tries again)
 *   ?case=commit-gated  the save stays pending until `window.__releaseSave()` (the page and a locked Next are on screen meanwhile)
 *   ?case=commit-throw  the FIRST save throws while it is being prepared, before it returns its promise (then it works)
 *   ?case=commit-tall   a failing save on a page far over one screen, drawn in the shell's scroll box (where is the message?)
 *   ?case=discovery     the flow's machine-discovery cover (`data-flow-loading`), a different cover from the step page's
 *   r11-1b G6: ?case=prefetch   a two-page wizard whose second page is a LAZY panel (the real `lazyComponent`, a 20 ms module load)
 *     drawn in its own Suspense with the shell's bar as the fallback, as the slot does; the real `NextPagePrefetch` draws it
 *     hidden while the first page shows. `window.__nextAt` / `__secondReadyAt` are performance.now() of the Next press and of the
 *     second page's `ready()`.
 *   ?case=late&ms=N   a page that says `ready()` N ms after it mounts; `window.__pageMountedAt` / `__readyAt` are performance.now()
 */
import { LivingBackground, Loading } from '@ferretry/app/ui';
import { ChoiceCards } from '@ferretry/app';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { EndPage } from '../../../../app/features/setup-flow/end-page.tsx';
import { NextPagePrefetch } from '../../../../app/features/setup-flow/next-page-prefetch.tsx';
import { FlowPage } from '../../../../app/features/setup-flow/page-frame.tsx';
import { lazyComponent } from '../../../../app/lazy.ts';
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
  fills: true as const,
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

/**
 * r11 O1: a page that registers a save (`window.__saves` counts the runs). `fail` makes the first run reject; `throws` makes the
 * first run throw before it returns a promise; `gated` keeps every run pending until `window.__releaseSave()`.
 */
function Saver({
  host,
  fail,
  throws,
  gated,
}: {
  readonly host: StepHost;
  readonly fail: boolean;
  readonly throws: boolean;
  readonly gated: boolean;
}): ReactNode {
  useEffect(() => {
    host.ready();
    const w = window as unknown as { __saves?: number; __releaseSave?: () => void };
    host.commit((): Promise<void> => {
      w.__saves = (w.__saves ?? 0) + 1;
      if (throws && w.__saves === 1) throw new Error('Could not prepare the request.');
      if (gated)
        return new Promise<void>(resolve => {
          w.__releaseSave = () => resolve();
        });
      if (fail && w.__saves === 1) return Promise.reject(new Error('Could not reach the machine.'));
      return Promise.resolve();
    });
  }, [host, fail, throws, gated]);
  return <p>A page that saves on Next.</p>;
}
/** r11 O1: the same, on a page of `height` px of cards (so Next is far above the end of the page). */
function TallSaver({ host }: { readonly host: StepHost }): ReactNode {
  return (
    <>
      <Saver host={host} fail throws={false} gated={false} />
      <Cards host={host} height={1_600} />
    </>
  );
}
/** r11 O1: a page that answers `ms` after it mounted. */
function Late({ host, ms }: { readonly host: StepHost; readonly ms: number }): ReactNode {
  useEffect(() => {
    const w = window as unknown as { __pageMountedAt?: number; __readyAt?: number };
    w.__pageMountedAt = performance.now();
    const timer = setTimeout(() => {
      w.__readyAt = performance.now();
      host.ready();
    }, ms);
    return () => clearTimeout(timer);
  }, [host, ms]);
  return <p>A page that answers late.</p>;
}

/** r11-1b G6: a panel whose module loads in 20 ms, through the real `lazyComponent` (one load, shared by every draw). */
const LazySecond = lazyComponent<{ readonly host: StepHost }>(async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
  return function SecondPanel({ host }) {
    useEffect(() => {
      (window as unknown as { __secondReadyAt?: number }).__secondReadyAt = performance.now();
      host.ready();
    }, [host]);
    return <p>The second page, from a lazy module.</p>;
  };
}) as (props: { readonly host: StepHost }) => ReactNode;
/** The slot's shape: the panel under its own Suspense with the shell's bar for a fallback. */
const secondPanel = (host: StepHost): ReactNode => (
  <Suspense fallback={<Loading kind="bar" label="Loading step…" />}>
    <LazySecond host={host} />
  </Suspense>
);
const SECOND: FlowStep = { ...STEP, key: 'fake-pack.second', id: 'second', title: 'Second page' };

function PrefetchWizard(): ReactNode {
  const [second, setSecond] = useState(false);
  if (second) return <FlowPage key="second" {...common} step={SECOND} render={secondPanel} silenceMs={600_000} />;
  return (
    <>
      <FlowPage
        key="first"
        {...common}
        onNext={() => {
          (window as unknown as { __nextAt?: number }).__nextAt = performance.now();
          setSecond(true);
        }}
        render={host => <Cards host={host} height={112} />}
        silenceMs={600_000}
      />
      <NextPagePrefetch steps={[SECOND]} render={host => secondPanel(host)} />
    </>
  );
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

/** Two pages, the first the case's page: Next on the first moves to a second page titled "Second page". */
function Wizard(): ReactNode {
  const [second, setSecond] = useState(false);
  if (second)
    return (
      <FlowPage
        key="second"
        {...common}
        step={{ ...STEP, key: 'fake-pack.second', id: 'second', title: 'Second page' }}
        render={(host: StepHost) => <Cards host={host} height={112} />}
        silenceMs={600_000}
      />
    );
  const render =
    scene === 'late'
      ? (host: StepHost) => <Late host={host} ms={Number(params.get('ms') ?? '250')} />
      : scene === 'commit-tall'
        ? (host: StepHost) => <TallSaver host={host} />
        : (host: StepHost) => (
            <Saver
              host={host}
              fail={scene === 'commit-fail'}
              throws={scene === 'commit-throw'}
              gated={scene === 'commit-gated'}
            />
          );
  return <FlowPage key="first" {...common} onNext={() => setSecond(true)} render={render} silenceMs={600_000} />;
}

const WIZARD_CASES = ['commit', 'commit-fail', 'commit-gated', 'commit-throw', 'commit-tall', 'late'];

function Scene(): ReactNode {
  if (scene === 'discovery')
    return (
      <div className="fy-sf-cover" data-flow-loading="">
        <Loading kind="page" label="Looking at what this machine can set up…" />
      </div>
    );
  if (scene === 'prefetch') return <PrefetchWizard />;
  if (WIZARD_CASES.includes(scene)) return <Wizard />;
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
          { plugin: 'onboarding', group: 'Machine', id: 'name', title: 'Name this machine', state: 'done' },
          { plugin: 'fake-pack', group: 'Fake Pack', id: 'choose', title: 'How should it import?', state: 'done' },
          { plugin: 'warden', group: 'Warden', id: 'warden', title: 'Warden', state: 'later' },
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
const inShell = scene === 'mid' || scene === 'tall' || scene === 'commit-tall';
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
