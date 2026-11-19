/**
 * The browser entry for ChoiceCards and StepPageFrame over fake data.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 *   ?scene=cards&n=<2..5>&w=<px>   n cards in a group w px wide (no w = the whole page)
 *   ?scene=frame[&tall=1]          a stepper page (tall=1 adds filler so the page scrolls) with progress, a demo, three cards and the footer
 */

import { Monitor, PanelLeft, PanelRight, Smartphone, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChoiceCards } from '../../../src/compose/choice-cards.tsx';
import { OptionBars } from '../../../src/compose/option-bars.tsx';
import { StepPageFrame } from '../../../src/compose/step-page-frame.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const ALL = [
  { id: 'left', title: 'Left', line: 'The menu beside your work', icon: <PanelLeft size={18} /> },
  { id: 'right', title: 'Right', line: 'The menu on the other edge', icon: <PanelRight size={18} /> },
  { id: 'bottom', title: 'Bottom', line: 'A bar under your thumb', icon: <Smartphone size={18} /> },
  { id: 'top', title: 'Top', line: 'A bar over the page', icon: <Monitor size={18} /> },
  { id: 'auto', title: 'Automatic', line: 'Ferretry picks by screen size', icon: <Sparkles size={18} /> },
] as const;

const Cards = ({ n, start }: { readonly n: number; readonly start: string | null }) => {
  const [value, setValue] = useState<string | null>(start);
  return <ChoiceCards label="Menu side" options={ALL.slice(0, n)} value={value} onChange={setValue} />;
};

const Frame = () => {
  const [value, setValue] = useState<string | null>('left');
  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-scroller="">
      <StepPageFrame
        title="Where should the menu sit?"
        line="You can change this later in Settings."
        progress={{
          segments: [
            { id: 'machine', label: 'Machine' },
            { id: 'claude', label: 'Claude Code' },
            { id: 'codex', label: 'Codex' },
            { id: 'device', label: 'This device' },
          ],
          current: 'claude',
          step: 2,
          of: 4,
        }}
        demo={
          <div style={{ padding: 12 }}>
            <OptionBars
              label="Menu"
              bars={[
                { label: 'Reach', value: 0.8 },
                { label: 'Room', value: 0.5 },
              ]}
            />
          </div>
        }
        back={{ onClick: () => undefined }}
        next={{ label: 'Next', onClick: () => undefined }}
      >
        <ChoiceCards label="Menu side" options={ALL.slice(0, 3)} value={value} onChange={setValue} />
        {params.get('tall') === '1' ? <div style={{ height: 900 }} aria-hidden="true" /> : null}
      </StepPageFrame>
    </div>
  );
};

const n = Math.min(5, Math.max(1, Number(params.get('n') ?? '3')));
const width = params.get('w') === null ? undefined : Number(params.get('w'));
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    params.get('scene') === 'frame' ? (
      <Frame />
    ) : (
      <div className="p-4">
        <div data-group="" style={{ width, maxWidth: '100%' }}>
          <Cards n={n} start={params.get('start') === 'none' ? null : 'left'} />
        </div>
      </div>
    ),
  );
