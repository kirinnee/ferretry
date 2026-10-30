/**
 * HOW ONE HISTORY EVENT OF A CARD READS, in words — the one spelling every surface uses: `fy task show`
 * draws it, and the Warden hands a resumed ferret the last lines of its card in it.
 *
 * Pure. The caller says how a lane id and a session id read, because only it holds the lane set and the
 * session directory.
 */
import type { BoardTaskEvent } from './board.ts';
import { formatTaskRef } from './board-refs.ts';

/** How a lane id or a session id reads to whoever is shown the line. */
export type BoardNamer = (id: string) => string;

/** One history event's wording; the closed union means every event this build can read is spelled here. */
export function describeBoardEvent(event: BoardTaskEvent, lane: BoardNamer, names: BoardNamer): string {
  switch (event.type) {
    case 'created':
      return `created in ${lane(event.laneId)}`;
    case 'moved': {
      const why = event.reason === null ? '' : `: ${event.reason}`;
      const auto = event.auto === true ? ` (auto${event.trigger === undefined ? '' : `, ${event.trigger}`})` : '';
      return `${event.backward ? 'moved back' : 'moved'} ${lane(event.from)} → ${lane(event.to)}${auto}${why}`;
    }
    case 'reopened':
      return `reopened ${lane(event.from)} → ${lane(event.to)}: ${event.reason} — ask: ${event.ask.text}`;
    case 'note':
      return `note: ${event.text}`;
    case 'clarified':
      return `clarified: ${event.text}`;
    case 'linked':
      return `linked ${event.field}: ${event.value}`;
    case 'assigned':
      return `assigned ${event.from === null ? 'nobody' : names(event.from)} → ${event.to === null ? 'nobody' : names(event.to)}`;
    case 'depended':
      return `depends on ${formatTaskRef(event.task)} until ${event.until}${event.override === undefined ? '' : ` (owner override: ${event.override.reason})`}`;
    case 'undepended':
      return `no longer depends on ${formatTaskRef(event.task)}: ${event.reason}`;
    case 'blocked':
      return `blocked: ${event.reason}`;
    case 'unblocked':
      return `unblocked${event.reason === null ? '' : `: ${event.reason}`}`;
    case 'field-edited':
      return `edited ${event.field}`;
    case 'file-claimed':
      return `claimed ${event.path}`;
    case 'file-released':
      return `released ${event.path}${event.reason === null ? '' : `: ${event.reason}`}`;
    case 'ordered':
      return `ranked ${event.from === null ? '—' : String(event.from)} → ${event.to === null ? '—' : String(event.to)}`;
    case 'refiled':
      return `refiled to ${event.toProject} (${lane(event.toLane)})${event.reason === null ? '' : `: ${event.reason}`}`;
    case 'dropped':
      return `dropped: ${event.reason}`;
    case 'migrated':
      return `migrated from ${event.legacyRef}`;
  }
}
