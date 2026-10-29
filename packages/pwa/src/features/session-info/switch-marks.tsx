/**
 * A FERRET'S SWITCH MARKS: one small icon for each section its system prompt carries — Learning (the
 * graduation cap), Hypermedia (shapes), Pack mode (a paw) and Agenda mode (a to-do list) — drawn only while that section is ON, in
 * that order, so a glance at a row or a header says what the ferret has been told.
 *
 * In a list row the marks are NOT controls: the row is a link, and a tap on a mark is a tap on the row.
 * In the session header, where the owner may control the ferret, Hypermedia, Pack mode and Agenda mode are buttons that
 * switch the section off through the ferret's own switch — the same PATCH the Actions menu sends — and
 * the daemon's answer ("takes effect when the ferret restarts") is shown by that switch's status line.
 * Every mark carries its state in words as its accessible name and its tooltip.
 */

import { ListTodo, PawPrint, Shapes } from 'lucide-react';
import { PassiveLearningMark } from '../learning/passive-learning.tsx';

/** What each mark says in words: its accessible name, and the tooltip a pointer reads. */
export const HYPERMEDIA_MARK_LABEL = 'Hypermedia on: may explain with diagrams, drawings, interactive pages and media';
export const PACK_MARK_LABEL = 'Pack mode on: may delegate to sub-ferrets';
export const AGENDA_MARK_LABEL = 'Agenda mode on: keeps an agenda of open items';

/** The sections a header mark can switch. */
export type SwitchSection = 'hypermedia' | 'pack' | 'agenda';

export interface SwitchMarksProps {
  readonly learning: boolean;
  readonly hypermedia: boolean;
  readonly pack: boolean;
  /** Absent: the caller has no fresher answer than the record, so the header reads the record. */
  readonly agenda?: boolean;
  /** Header only: switches a section, for a reader who may control this ferret. Absent: marks only. */
  readonly onToggle?: (section: SwitchSection, next: boolean) => void;
}

/** What a header tap reaches: each section's own switch, the one its Actions toggle sends. */
export type SwitchTaps = Readonly<
  Record<SwitchSection, { readonly tap: (sessionId: string, next: boolean) => Promise<void> }>
>;

/** The header's `onToggle` for one ferret, over the switches' own taps (each reports its own refusal). */
export const switchTapper =
  (taps: SwitchTaps, sessionId: string) =>
  (section: SwitchSection, next: boolean): void => {
    void taps[section].tap(sessionId, next);
  };

const SECTION_MARKS = [
  { section: 'hypermedia', label: HYPERMEDIA_MARK_LABEL, Icon: Shapes },
  { section: 'pack', label: PACK_MARK_LABEL, Icon: PawPrint },
  { section: 'agenda', label: AGENDA_MARK_LABEL, Icon: ListTodo },
] as const;

export function SwitchMarks({ learning, hypermedia, pack, agenda, onToggle }: SwitchMarksProps) {
  const on = { hypermedia, pack, agenda: agenda ?? false };
  const shown = SECTION_MARKS.filter(mark => on[mark.section]);
  if (!learning && shown.length === 0) return null;
  return (
    <span className="fy-switch-marks" data-switch-marks="">
      {learning ? <PassiveLearningMark /> : null}
      {shown.map(({ section, label, Icon }) =>
        onToggle === undefined ? (
          <span
            aria-label={label}
            className="fy-switch-mark"
            data-switch-mark={section}
            key={section}
            role="img"
            title={label}
          >
            <Icon aria-hidden="true" size={13} />
          </span>
        ) : (
          <button
            aria-label={`${label}. Turn it off — takes effect when this ferret restarts`}
            className="fy-switch-mark fy-switch-mark--button"
            data-switch-mark={section}
            key={section}
            onClick={() => onToggle(section, false)}
            title={`${label}. Tap to turn off; it takes effect when this ferret restarts.`}
            type="button"
          >
            <Icon aria-hidden="true" size={13} />
          </button>
        ),
      )}
    </span>
  );
}
