/**
 * A small CSS scene for the Warden page: a ferret is flagged, then (for the two layers that act) the flag clears. It
 * plays ONCE when the scene mounts (the page re-keys it on a new answer) and rests on its last frame; with motion off,
 * by the OS or by Settings, it is only the last frame. Decorative: the cards carry the words.
 */
import type { WardenChoice } from './warden-step-model.ts';
import './warden-step.css';

const RESULT: Readonly<Record<WardenChoice, { readonly mark: string; readonly line: string }>> = {
  rules: { mark: 'Needs you', line: 'Shown to you' },
  jev: { mark: 'Cleared', line: 'Jev: looks fine' },
  llm: { mark: 'Cleared', line: 'Investigated, nudged' },
};

export function WardenDemo({ choice }: { readonly choice: WardenChoice }) {
  const result = RESULT[choice];
  return (
    <div className="wd-demo" data-warden-demo={choice} aria-hidden="true">
      <span className="wd-demo__ferret">ferret-3</span>
      <span className="wd-demo__layers">
        <span className="wd-demo__layer wd-demo__layer--flag">
          <span className="wd-demo__dot" /> Stuck 12 min · flagged
        </span>
        <span className="wd-demo__layer wd-demo__layer--result" data-result={choice === 'rules' ? 'open' : 'clear'}>
          <span className="wd-demo__dot" /> {result.mark} · {result.line}
        </span>
      </span>
    </div>
  );
}
