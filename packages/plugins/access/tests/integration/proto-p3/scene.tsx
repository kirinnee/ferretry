/**
 * THROWAWAY PROTOTYPE (P3 phase 1): the scene. `?option=a|b&stage=confirm|pairing|paired&theme=studio-light&details=1`.
 * With no `stage` it is a live flow: press the button, a fake 1.1 s exchange, then the success moment.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionA } from './option-a.tsx';
import { OptionB } from './option-b.tsx';
import type { Stage } from './shared.tsx';
import './proto.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const option = params.get('option') === 'b' ? 'b' : 'a';
const fixed = params.get('stage') as Stage | null;

function Flow() {
  const [stage, setStage] = useState<Stage>(fixed ?? 'confirm');
  const props = {
    stage,
    detailsOpen: params.get('details') === '1',
    onPair: () => {
      if (fixed !== null) return;
      setStage('pairing');
      setTimeout(() => setStage('paired'), 1100);
    },
    onCancel: () => setStage('confirm'),
  };
  return (
    <div className="p3-page" data-option={option}>
      {option === 'a' ? <OptionA {...props} /> : <OptionB {...props} />}
      <p className="p3-sr" role="status">
        {stage === 'pairing'
          ? 'Pairing with this machine…'
          : stage === 'paired'
            ? 'Connected. Paired with kirin-workstation.'
            : ''}
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Flow />);
