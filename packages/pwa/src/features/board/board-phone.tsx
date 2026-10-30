/**
 * THE BOARD ON A PHONE: one lane at a time. The lanes are a strip of chips along the top, a swipe (or the
 * arrow keys on the strip) moves to the next lane, and the chosen lane's cards run down the page as a list.
 *
 * The lane shown is the page's (`at`, in the URL, so back from a card returns to the same lane). This
 * component keeps no state of its own and decides nothing about moves; it draws `PlacedCard` like every
 * other view and only turns a finger or a key into "the next lane".
 */

import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from 'react';
import type { BoardModel } from '../../lib/board-model.ts';
import {
  type LaneStep,
  keyStep,
  phoneLanes,
  shownLane,
  stepLane,
  swipeStep,
  UNPLACED_LANE,
} from '../../lib/board-phone.ts';
import type { BoardGroupOf } from '../../lib/board-view.ts';
import { type BoardCardEnv, PlacedCard } from './board-views.tsx';

export interface PhoneKanbanProps {
  readonly model: BoardModel;
  readonly env: BoardCardEnv;
  readonly projectName: (group: BoardGroupOf) => string;
  readonly hideClosed: boolean;
  /** The lane the URL names, or `null` for the first lane with a card. */
  readonly at: string | null;
  readonly onLane: (laneId: string) => void;
}

interface Touch {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

function PhoneBoard({
  group,
  env,
  title,
  hideClosed,
  at,
  onLane,
}: {
  readonly group: BoardGroupOf;
  readonly env: BoardCardEnv;
  readonly title: string;
  readonly hideClosed: boolean;
  readonly at: string | null;
  readonly onLane: (laneId: string) => void;
}) {
  const lanes = phoneLanes(group, hideClosed);
  const shown = shownLane(lanes, at);
  const touch = useRef<Touch | null>(null);
  const swiped = useRef(false);
  const strip = useRef<HTMLDivElement>(null);

  // The chip you are on stays in view, whichever way you got there.
  const shownId = shown?.id;
  useEffect(() => {
    const row = strip.current;
    const chips = [...(row?.children ?? [])];
    const chip = chips.find(candidate => candidate instanceof HTMLElement && candidate.dataset['lane'] === shownId);
    if (row === null || !(chip instanceof HTMLElement)) return;
    // Scroll the strip alone: scrollIntoView would also slide the whole page sideways.
    row.scrollLeft = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
  }, [shownId]);

  if (shown === null) return <p className="fy-board__empty">No lanes on this board.</p>;

  const go = (step: LaneStep | 'first' | 'last'): string | null => {
    const next = stepLane(
      lanes.map(lane => lane.id),
      shown.id,
      step,
    );
    if (next !== null) onLane(next);
    return next;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = keyStep(event.key);
    if (step === null) return;
    event.preventDefault();
    const next = go(step);
    if (next === null) return;
    const chip = strip.current?.children[lanes.findIndex(lane => lane.id === next)];
    if (chip instanceof HTMLElement) chip.focus();
  };

  const begin = (event: PointerEvent<HTMLElement>): void => {
    swiped.current = false;
    touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const finish = (event: PointerEvent<HTMLElement>): void => {
    const start = touch.current;
    touch.current = null;
    if (start === null || start.id !== event.pointerId) return;
    const step = swipeStep(event.clientX - start.x, event.clientY - start.y);
    if (step === null) return;
    swiped.current = true;
    go(step);
  };

  const cards =
    shown.id === UNPLACED_LANE ? group.unplaced : (group.lanes.find(lane => lane.id === shown.id)?.cards ?? []);
  const panelId = `${group.key}~panel`;

  return (
    <div className="fy-board-phone" data-lanes={lanes.length}>
      <div
        aria-label={`${title} lanes`}
        className="fy-board-phone__strip"
        onKeyDown={onKeyDown}
        ref={strip}
        role="tablist"
      >
        {lanes.map(lane => {
          const selected = lane.id === shown.id;
          return (
            <button
              aria-controls={panelId}
              aria-label={`${lane.name}, ${lane.count} ${lane.count === 1 ? 'card' : 'cards'}`}
              aria-selected={selected}
              className="fy-board-phone__chip"
              data-lane={lane.id}
              data-empty={lane.count === 0 ? '' : undefined}
              key={lane.id}
              onClick={() => onLane(lane.id)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <span className="fy-board-phone__chip-name">{lane.name}</span>
              <span className="fy-board-phone__chip-n">{lane.count}</span>
            </button>
          );
        })}
      </div>
      <div
        aria-label={`${shown.name}, ${shown.count} ${shown.count === 1 ? 'card' : 'cards'}`}
        className="fy-board-phone__panel"
        data-lane={shown.id}
        id={panelId}
        onClickCapture={event => {
          if (!swiped.current) return;
          swiped.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerCancel={() => {
          touch.current = null;
        }}
        onPointerDown={begin}
        onPointerUp={finish}
        role="tabpanel"
      >
        <ul className="fy-board-lane__cards">
          {cards.length === 0 ? (
            <li className="fy-board-lane__empty">Nothing here</li>
          ) : (
            cards.map(card => <PlacedCard card={card} env={env} key={card.key} />)
          )}
        </ul>
      </div>
    </div>
  );
}

/** One strip per project (and machine); with a single project the heading is left out. */
export function PhoneKanban({ model, env, projectName, hideClosed, at, onLane }: PhoneKanbanProps) {
  const headed = model.groups.length > 1;
  return (
    <div className="fy-board-rows">
      {model.groups.map(group => (
        <section aria-label={headed ? projectName(group) : 'Board'} className="fy-board-project" key={group.key}>
          {headed ? (
            <h2 className="fy-board-project__head">
              {projectName(group)}
              {model.multiMachine ? <span className="fy-board-project__machine">{group.machine}</span> : null}
            </h2>
          ) : null}
          <PhoneBoard
            at={at}
            env={env}
            group={group}
            hideClosed={hideClosed}
            onLane={onLane}
            title={projectName(group)}
          />
        </section>
      ))}
    </div>
  );
}
