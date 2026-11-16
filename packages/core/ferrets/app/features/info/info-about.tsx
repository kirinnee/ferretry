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
import { OutdatedMark } from '../restart-outdated/outdated-mark.tsx';
import { InfoRow, InfoSection } from './info-parts.tsx';
import { activeSubFerrets, SubFerretsPack } from './sub-ferrets.tsx';

export interface InfoAboutProps {
  /** This ferret: its `outdated` flag is what the mark beside Restart says. */
  readonly ferret: FerretSummary;
  /** The daemon's client, which keys what "Restart outdated" last answered (`restart-outdated/restart-overlay.ts`). */
  readonly overlayKey?: object;
  /** The ferrets this one started (`lineage(...).children`). */
  readonly subFerrets: readonly FerretSummary[];
  readonly onOpenFerret?: (ferretId: string) => void;
  /** The board card this ferret was started on, as its id. Absent: it has none. */
  readonly card?: string;
  /** The same Restart as Actions › Restart CLI; true once it restarted, false when it was paused. Absent: this reader may not restart it. */
  readonly onRestart?: () => Promise<boolean>;
}

function RestartRow({ ferret, overlayKey, onRestart }: Pick<InfoAboutProps, 'ferret' | 'overlayKey' | 'onRestart'>) {
  const [busy, setBusy] = useState(false);
  // The mark is a fact about the ferret, not a control: a reader who may not restart it still sees that it is outdated.
  const mark = <OutdatedMark ferret={ferret} overlayKey={overlayKey} />;
  if (onRestart === undefined) return ferret.outdated === undefined ? null : <InfoRow label="Restart">{mark}</InfoRow>;
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
      {mark}
    </InfoRow>
  );
}

export function InfoAbout({ ferret, overlayKey, subFerrets, onOpenFerret, card, onRestart }: InfoAboutProps) {
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
        <RestartRow ferret={ferret} overlayKey={overlayKey} {...(onRestart === undefined ? {} : { onRestart })} />
      </InfoSection>
    </section>
  );
}
