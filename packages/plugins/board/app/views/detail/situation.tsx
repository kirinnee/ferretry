import type { ReactNode } from 'react';
import { PointForm, type ProseRenderer } from '../prose.tsx';

/** One part of a card's progress, drawn under its label. */
export interface ProgressPart {
  readonly key: string;
  readonly label: string;
  readonly text: string;
}

/**
 * THE SITUATION: the card's progress (Now / Done so far / Next, the empty ones left out), then the premise and the
 * context as two calm blocks. A card shows what is going on; it asks nothing here (#1552).
 */
export function Situation({
  premise,
  context,
  progress = [],
  renderProse,
}: {
  readonly premise: string | null;
  readonly context: string | null;
  readonly progress?: readonly ProgressPart[];
  readonly renderProse: ProseRenderer;
}): ReactNode {
  if (premise === null && context === null && progress.length === 0) return null;
  return (
    <section aria-label="Situation" className="fy-card__situation" data-card-situation="">
      {progress.length === 0 ? null : (
        <div className="fy-card__sit-row" data-card-section="progress">
          <h4 className="fy-card__label fy-card__sit-label">Progress</h4>
          <div className="fy-card__status">
            {progress.map(part => (
              <div className="fy-card__status-part" data-progress-part={part.key} key={part.key}>
                <h5 className="fy-card__status-label">{part.label}</h5>
                {renderProse(part.text)}
              </div>
            ))}
          </div>
        </div>
      )}
      {premise === null ? null : (
        <div className="fy-card__sit-row" data-card-section="premise">
          <h4 className="fy-card__label fy-card__sit-label">Premise</h4>
          <PointForm className="fy-card__points" renderProse={renderProse} text={premise} />
        </div>
      )}
      {context === null ? null : (
        <div className="fy-card__sit-row" data-card-section="context">
          <h4 className="fy-card__label fy-card__sit-label">Context</h4>
          <PointForm className="fy-card__points" renderProse={renderProse} text={context} />
        </div>
      )}
    </section>
  );
}
