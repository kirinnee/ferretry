/**
 * The browser entry for the r11 O2 step page layout over fake data: a page with 3 stacked cards, a `StepDemo` in its
 * body, a row of in-body Buttons and the frame's footer.
 *
 *   ?theme=<family>-<mode>
 *   ?scene=stack   stacked cards + StepDemo (the pages the plugins draw)
 *   ?scene=prop    the same page with the old `demo` prop instead of StepDemo
 *   ?scene=none    stacked cards, no demo at all
 *   ?scene=inline  a StepDemo OUTSIDE a frame (renders inline)
 */

import { Monitor, PanelLeft, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChoiceCards } from '../../../src/compose/choice-cards.tsx';
import { StepDemo } from '../../../src/compose/step-demo.tsx';
import { StepPageFrame } from '../../../src/compose/step-page-frame.tsx';
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
  <div data-fake-demo="" style={{ height: 220, width: '100%', background: 'var(--accent-soft)' }}>
    animation
  </div>
);

const Page = () => {
  const [value, setValue] = useState<string | null>('auto');
  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-scroller="">
      <StepPageFrame
        title="How should Claude Code run?"
        line="You can change this later in Settings."
        {...(scene === 'prop' ? { demo: <Demo /> } : {})}
        back={{ onClick: () => undefined }}
        later={{ onClick: () => undefined }}
        next={{ label: 'Next', onClick: () => undefined }}
      >
        <ChoiceCards label="Permission mode" layout="stack" options={OPTIONS} value={value} onChange={setValue} />
        {scene === 'stack' ? (
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
    ) : (
      <Page />
    ),
  );
