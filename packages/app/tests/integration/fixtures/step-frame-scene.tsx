/**
 * The browser entry for the r11 O2 step page layout over fake data: a page with 3 stacked cards, a `StepDemo` in its
 * body, a row of in-body Buttons and the frame's footer.
 *
 *   ?theme=<family>-<mode>
 *   ?scene=stack   stacked cards + StepDemo (the pages the plugins draw)
 *   ?scene=prop    the same page with the old `demo` prop instead of StepDemo
 *   ?scene=none    stacked cards, no demo at all
 *   ?scene=inline  a StepDemo OUTSIDE a frame (renders inline)
 *   ?scene=long    the ending's footer: Back + a long Next label ("Open this machine"), no Later
 *   ?scene=busy&busyMs=N  the stack page whose Next is busy (the footer's busy mark) for N ms after it is pressed (r11-1c C3)
 *   ?scene=covered a step checked behind its page loader (onboarding's cover): the loader sits in the middle of the area (O8-4c)
 *   ?scene=pending a FlowPage-shaped page: its slot is `hidden` behind a loading cover until the button is pressed
 */

import { Monitor, PanelLeft, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChoiceCards } from '../../../src/compose/choice-cards.tsx';
import { StepDemo } from '../../../src/compose/step-demo.tsx';
import { StepPageFrame } from '../../../src/compose/step-page-frame.tsx';
import { Loading } from '../../../src/ui/loading.tsx';
import { Button } from '../../../src/ui/primitives.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'stack';

const OPTIONS = [
  { id: 'auto', title: 'Auto mode', line: 'Claude asks before anything risky', icon: <PanelLeft size={18} /> },
  { id: 'skip', title: 'Skip permissions', line: 'Runs everything without asking', icon: <Smartphone size={18} /> },
  {
    id: 'plan',
    title: 'Plan only',
    line: 'A much longer line that explains the choice in more words than one line can hold so it must clamp to two',
    icon: <Monitor size={18} />,
  },
] as const;

const Demo = () => (
  <div
    data-fake-demo=""
    style={{
      alignItems: 'center',
      background: 'var(--accent-soft)',
      display: 'flex',
      height: 300,
      justifyContent: 'center',
      width: '100%',
    }}
  >
    animation
  </div>
);

/** The shape FlowPage draws: a cover while pending, the page's own slot `hidden` until it is ready. */
const Pending = () => {
  const [ready, setReady] = useState(false);
  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-scroller="">
      <StepPageFrame
        title="Checking"
        back={{ onClick: () => undefined }}
        next={{ label: 'Make ready', onClick: () => setReady(true) }}
      >
        {ready ? null : <div data-flow-cover="">Checking what this step needs…</div>}
        <div hidden={!ready} data-flow-slot="">
          <StepDemo>
            <Demo />
          </StepDemo>
          <p>page body</p>
        </div>
      </StepPageFrame>
    </div>
  );
};

/** The shape onboarding draws while a step is checked (O8-4c): the page loader inside the plugin's page and cover boxes, in the frame's body. */
const Covered = () => (
  <div style={{ height: '100vh', overflow: 'auto' }} data-scroller="">
    <StepPageFrame
      title="Checking"
      line="Ferretry is looking at this machine."
      back={{ onClick: () => undefined }}
      next={{ label: 'Next', busy: true, onClick: () => undefined }}
    >
      <div data-flow-page="">
        <div data-flow-cover="">
          <Loading kind="page" label="Checking what this step needs…" />
        </div>
      </div>
    </StepPageFrame>
  </div>
);

const Page = () => {
  const [value, setValue] = useState<string | null>('auto');
  const [busy, setBusy] = useState(false);
  const pressNext = (): void => {
    if (scene !== 'busy') return;
    setBusy(true);
    window.setTimeout(() => setBusy(false), Number(params.get('busyMs') ?? 0));
  };
  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-scroller="">
      <StepPageFrame
        title="How should Claude Code run?"
        line="You can change this later in Settings."
        {...(scene === 'prop' ? { demo: <Demo /> } : {})}
        back={{ onClick: () => undefined }}
        {...(scene === 'long' ? {} : { later: { onClick: () => undefined } })}
        next={{ label: scene === 'long' ? 'Open this machine' : 'Next', busy, onClick: pressNext }}
      >
        <ChoiceCards label="Permission mode" layout="stack" options={OPTIONS} value={value} onChange={setValue} />
        {scene === 'stack' || scene === 'busy' ? (
          <StepDemo>
            <Demo />
          </StepDemo>
        ) : null}
        <div data-in-body-buttons="" style={{ display: 'flex', marginTop: 16 }}>
          <Button>Check</Button>
          <Button variant="primary">Go</Button>
        </div>
      </StepPageFrame>
    </div>
  );
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    scene === 'inline' ? (
      <div data-outside="">
        <StepDemo>
          <Demo />
        </StepDemo>
      </div>
    ) : scene === 'pending' ? (
      <Pending />
    ) : scene === 'covered' ? (
      <Covered />
    ) : (
      <Page />
    ),
  );
