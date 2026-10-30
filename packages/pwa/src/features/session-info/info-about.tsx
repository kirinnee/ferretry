/**
 * Info › Overview › "About this ferret": the facts the chat's top bar used to carry beside the name, in
 * one compact block. The owner (2026-10-30) called the bar too crowded, so the sub-ferrets pill, the card
 * chip, the capability icons, the refresh mark and the Agenda toggle moved here. Nothing was lost, only
 * moved: every row keeps the control it had in the bar.
 *
 * The agenda is a section of this block, not a side bar of its own; the floating "Agenda · n need you" line
 * above the composer stays the quick way in.
 *
 * PRESENTATIONAL: the page owns every action and state and hands this block what to draw.
 */

import type { SessionView } from '@ferretry/protocol';
import { type ReactNode, useState } from 'react';
import { activeSubFerrets, SubFerretsPack } from '../../components/sub-ferrets.tsx';
import { type ChatChip, chatCardLabel } from '../../lib/board-chat.ts';
import { OutdatedGlyph, useOutdatedMarkState } from '../restart-outdated/outdated-mark.tsx';
import { agendaOn, hypermediaOn, packOn } from './info-model.ts';
import { InfoRow, InfoSection } from './info-parts.tsx';
import { SwitchMarks, type SwitchMarksProps } from './switch-marks.tsx';

export interface InfoAboutProps {
  readonly view: SessionView;
  /** The ferrets this one started (`lineage(...).children`). */
  readonly subFerrets: readonly SessionView[];
  readonly onOpenSession?: (sessionId: string) => void;
  /** The ferret's focus card and how to open it. Absent: the host has no board, so there is no Card row. */
  readonly card?: {
    readonly chip: ChatChip;
    readonly onOpen: () => void;
    /** Opens the project Board narrowed to this ferret's cards with the focus card marked. Absent: no board to open. */
    readonly onOpenBoard?: () => void;
  };
  /** The switch marks and, for a reader who may control the ferret, the tap that switches one. Absent: read from the record. */
  readonly switches?: SwitchMarksProps;
  /** The same Restart as Actions › Restart CLI. Absent: this reader may not restart it. */
  readonly onRestart?: () => Promise<void>;
  /** The agenda's rows (`useAgenda().section`). Absent: this ferret is not in agenda mode. */
  readonly agenda?: ReactNode;
}

function RestartRow({ view, onRestart }: Pick<InfoAboutProps, 'view' | 'onRestart'>) {
  const state = useOutdatedMarkState(view);
  const [busy, setBusy] = useState(false);
  if (onRestart === undefined && state === null) return null;
  return (
    <InfoRow label="Restart">
      {state === null ? null : <OutdatedGlyph state={state} view={view} />}
      {onRestart === undefined ? null : (
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
      )}
    </InfoRow>
  );
}

export function InfoAbout({ view, subFerrets, onOpenSession, card, switches, onRestart, agenda }: InfoAboutProps) {
  const marks: SwitchMarksProps = {
    agenda: agendaOn(view),
    ...(switches ?? { learning: false, hypermedia: hypermediaOn(view), pack: packOn(view) }),
  };
  const anyOn = marks.learning || marks.hypermedia || marks.pack || marks.agenda === true;
  return (
    <section aria-label="About this ferret" className="fy-info-about" data-info-about="">
      <InfoSection title="About this ferret">
        <InfoRow label={`Sub-ferrets (${activeSubFerrets(subFerrets).length})`}>
          {subFerrets.length === 0 ? (
            <span className="fy-info-muted">None</span>
          ) : (
            <SubFerretsPack onOpenSession={onOpenSession} sessions={subFerrets} />
          )}
        </InfoRow>
        {card === undefined ? null : (
          <InfoRow label="Card">
            {card.chip.kind === 'none' ? (
              <span className="fy-info-warn" data-info-card="none">
                No card
              </span>
            ) : (
              <button
                className="fy-info-inline-action"
                data-info-card={card.chip.id}
                onClick={card.onOpen}
                title={card.chip.title ?? undefined}
                type="button"
              >
                {chatCardLabel(card.chip)}
              </button>
            )}
            {card.onOpenBoard === undefined ? null : (
              <button
                className="fy-info-inline-action"
                data-info-open-board=""
                onClick={card.onOpenBoard}
                title="Open the board with this ferret's cards"
                type="button"
              >
                Open board
              </button>
            )}
          </InfoRow>
        )}
        <InfoRow label="Capabilities">
          {anyOn ? <SwitchMarks {...marks} /> : <span className="fy-info-muted">None on</span>}
        </InfoRow>
        <RestartRow onRestart={onRestart} view={view} />
        {agenda === undefined || agenda === null ? null : (
          <InfoRow label="Agenda">
            <span className="fy-info-about__agenda" data-info-agenda="">
              {agenda}
            </span>
          </InfoRow>
        )}
      </InfoSection>
    </section>
  );
}
