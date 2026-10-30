/**
 * THE CARD A RESUMED FERRET CONTINUES (`board-design.md` §3.4): when the Warden starts a dead ferret again —
 * an auto-revive, or a verdict's resume or restart — the turn it hands over names the ferret's focus card,
 * so the successor carries on the same card rather than rediscovering what it was doing.
 *
 * The block says what the card is (id, title, lane), what the owner asked for in their own words (the ask
 * and every clarification, verbatim), where the work is (its links) and what happened to it last (the
 * newest history lines, in the words `fy task show` uses).
 *
 * Pure: the card arrives already read (`WardenBoardPort.focusCard`).
 */
import {
  type BoardTaskView,
  describeBoardEvent,
  ferretryNotice,
  formatTaskRef,
  type LaneSet,
  type PrLink,
} from '@ferretry/protocol';

/** A ferret's focus card, with the lanes of its board so the lane reads by name. */
export interface WardenFocusCard {
  readonly task: BoardTaskView;
  readonly laneSet: LaneSet | null;
}

/** How many of the newest history lines a resumed ferret is shown. */
export const FOCUS_HISTORY_LINES = 5;

const laneName = (laneSet: LaneSet | null, id: string): string =>
  laneSet?.lanes.find(lane => lane.id === id)?.name ?? id;

const prLine = (pr: PrLink): string => `PR #${String(pr.number)} ${pr.url} (${pr.draft ? 'draft' : pr.state})`;

/** The card, as the block a resumed ferret reads. Session ids stay ids: the Warden holds no directory. */
export function focusCardBrief(card: WardenFocusCard): string {
  const { task, laneSet } = card;
  const ref = formatTaskRef(task);
  const lines = [
    `Your card: ${ref} — ${task.title}`,
    `Lane: ${laneName(laneSet, task.laneId)}`,
    '',
    `The ask, verbatim (${task.ask.source}):`,
    task.ask.text,
  ];
  for (const clarification of task.clarifications)
    lines.push('', `Clarified, verbatim (${clarification.source}):`, clarification.text);
  const links = [
    ...task.links.prs.map(prLine),
    ...(task.links.branch === null ? [] : [`branch ${task.links.branch}`]),
    ...task.links.commits.map(commit => `commit ${commit}`),
    ...task.links.docs.map(doc => `doc ${doc}`),
  ];
  if (links.length > 0) lines.push('', 'Links:', ...links.map(link => `- ${link}`));
  const recent = task.history.slice(-FOCUS_HISTORY_LINES);
  lines.push(
    '',
    'Last on the card:',
    ...recent.map(
      event =>
        `- ${event.at}  ${describeBoardEvent(
          event,
          id => laneName(laneSet, id),
          id => id,
        )}`,
    ),
    '',
    `Carry on with ${ref}: move it as you work (\`fy task move ${task.id} <lane>\`), and note why if you stop.`,
  );
  return lines.join('\n');
}

/** Why the Warden started the ferret again, as the first line of its turn. */
export type WardenResumeAct = 'resume' | 'restart';

/**
 * The turn a verdict's resume or restart hands a ferret that has a focus card. A ferret with none is
 * resumed with the resume domain's own default turn, as before.
 */
export function wardenResumeMessage(act: WardenResumeAct, reason: string, card: WardenFocusCard): string {
  const did = act === 'restart' ? 'restarted you with your conversation intact' : 'resumed you';
  const why = reason.trim().replace(/\.$/u, '');
  return ferretryNotice(
    `The Warden ${did}: ${why}.\n\n` +
      'This notice is from Ferretry, not from the owner. Re-read your last turn and continue from where you ' +
      'stopped, on the card below.\n\n' +
      focusCardBrief(card),
  );
}
