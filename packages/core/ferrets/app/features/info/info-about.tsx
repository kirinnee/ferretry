/**
 * Info › Overview › "About this ferret": the facts the header used to carry beside the name, in one compact block —
 * the sub-ferrets it started, its card, and the Restart that relaunches it on the same login.
 *
 * The capabilities (the Learning, Hypermedia, Pack and Agenda switches), the memory note and the agenda line are the
 * facts of other owners (Learning, Conversation's instructions, the Agenda); their panels draw them.
 *
 * PRESENTATIONAL: the host owns every action and state and hands this block what to draw.
 */

import { useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import { InfoRow, InfoSection } from './info-parts.tsx';
import { activeSubFerrets, SubFerretsPack } from './sub-ferrets.tsx';

export interface InfoAboutProps {
  /** The ferrets this one started (`lineage(...).children`). */
  readonly subFerrets: readonly FerretSummary[];
  readonly onOpenFerret?: (ferretId: string) => void;
  /** The board card this ferret was started on, as its id. Absent: it has none. */
  readonly card?: string;
  /** The same Restart as Actions › Restart CLI; true once it restarted, false when it was paused. Absent: this reader may not restart it. */
  readonly onRestart?: () => Promise<boolean>;
}

function RestartRow({ onRestart }: Pick<InfoAboutProps, 'onRestart'>) {
  const [busy, setBusy] = useState(false);
  if (onRestart === undefined) return null;
  return (
    <InfoRow label="Restart">
      <button
        className="fy-info-inline-action"
        data-info-restart=""
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onRestart().then(
            () => setBusy(false),
            () => setBusy(false),
          );
        }}
        title="Restart this ferret’s CLI, keeping its conversation"
        type="button"
      >
        {busy ? 'Restarting…' : 'Restart'}
      </button>
    </InfoRow>
  );
}

export function InfoAbout({ subFerrets, onOpenFerret, card, onRestart }: InfoAboutProps) {
  return (
    <section aria-label="About this ferret" className="fy-info-about" data-info-about="">
      <InfoSection title="About this ferret">
        <InfoRow label={`Sub-ferrets (${activeSubFerrets(subFerrets).length})`}>
          {subFerrets.length === 0 ? (
            <span className="fy-info-muted">None</span>
          ) : (
            <SubFerretsPack ferrets={subFerrets} {...(onOpenFerret === undefined ? {} : { onOpenFerret })} />
          )}
        </InfoRow>
        {card === undefined ? null : (
          <InfoRow label="Card">
            <span className="font-mono" data-info-card={card}>
              {card}
            </span>
          </InfoRow>
        )}
        <RestartRow {...(onRestart === undefined ? {} : { onRestart })} />
      </InfoSection>
    </section>
  );
}
