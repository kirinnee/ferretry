/**
 * HOW ONE HISTORY EVENT OF A CARD READS, in words — the one spelling every surface uses: `fy task show`
 * draws it, and the Warden hands a resumed ferret the last lines of its card in it.
 *
 * Pure. The caller says how a lane id and a session id read, because only it holds the lane set and the
 * session directory.
 */
import type { BoardActor, BoardAttachment, BoardTaskEvent } from './board.ts';
import { type BoardActorVia, formatTaskRef } from './board-refs.ts';

/** How a lane id or a session id reads to whoever is shown the line. */
export type BoardNamer = (id: string) => string;

const counted = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

/** What a reopen carried, in words: "2 images", "1 file", "2 images and 1 file". Empty for nothing. */
export function attachmentsPhrase(files: readonly Pick<BoardAttachment, 'mime'>[]): string {
  const images = files.filter(file => file.mime.startsWith('image/')).length;
  const others = files.length - images;
  return [images > 0 ? counted(images, 'image') : null, others > 0 ? counted(others, 'file') : null]
    .filter(part => part !== null)
    .join(' and ');
}

/**
 * Who a history line is BY: its actor, except a move on a trigger somebody reported, which reads as by whoever
 * reported it (`reportedBy`, with `reportedVia` for its `actorVia`) — the daemon only carried out their word,
 * and a ferret's report must never read as a fact Ferretry saw for itself.
 */
export const boardEventActor = (
  event: Pick<BoardTaskEvent, 'actor' | 'actorVia'> & {
    readonly reportedBy?: BoardActor;
    readonly reportedVia?: BoardActorVia;
  },
): { readonly actor: BoardActor; readonly via: BoardActorVia | undefined } =>
  event.reportedBy === undefined
    ? { actor: event.actor, via: event.actorVia }
    : { actor: event.reportedBy, via: event.reportedVia };

/** One history event's wording; the closed union means every event this build can read is spelled here. */
export function describeBoardEvent(event: BoardTaskEvent, lane: BoardNamer, names: BoardNamer): string {
  switch (event.type) {
    case 'created':
      return `created in ${lane(event.laneId)}`;
    case 'moved': {
      const why = event.reason === null ? '' : `: ${event.reason}`;
      const moved = `${event.backward ? 'moved back' : 'moved'} ${lane(event.from)} → ${lane(event.to)}`;
      if (event.reportedBy !== undefined) return `reported ${event.trigger ?? 'a trigger'} → ${moved}${why}`;
      const auto = event.auto === true ? ` (auto${event.trigger === undefined ? '' : `, ${event.trigger}`})` : '';
      return `${moved}${auto}${why}`;
    }
    case 'reopened':
      return `reopened ${lane(event.from)} → ${lane(event.to)}: ${event.reason} — ask: ${event.ask.text}${
        event.attachments === undefined ? '' : ` — with ${attachmentsPhrase(event.attachments)}`
      }`;
    case 'note':
      return `note: ${event.text}`;
    case 'clarified':
      return `clarified: ${event.text}`;
    case 'linked':
      return `linked ${event.field}: ${event.value}`;
    case 'assigned':
      return `assigned ${event.from === null ? 'nobody' : names(event.from)} → ${event.to === null ? 'nobody' : names(event.to)}${
        event.handedDown === true && event.actor.sessionId !== undefined
          ? ` (handed down by ${names(event.actor.sessionId)})`
          : ''
      }`;
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
    case 'snoozed':
      return event.until === null ? 'woke from snooze' : `snoozed until ${event.until}`;
    case 'refiled':
      return `refiled to ${event.toProject} (${lane(event.toLane)})${event.reason === null ? '' : `: ${event.reason}`}`;
    case 'reparented': {
      const why = event.reason === null ? '' : `: ${event.reason}`;
      const to = event.to === null ? 'now top level' : `under ${formatTaskRef(event.to)}`;
      const from = event.from === null ? 'top level' : formatTaskRef(event.from);
      return `re-parented ${to} (was ${from})${why}`;
    }
    case 'dropped':
      return `dropped: ${event.reason}`;
    case 'migrated':
      return `migrated from ${event.legacyRef}`;
  }
}
