import type { WorkHit, WorkKind } from '@ferretry/protocol';
import type { SessionDirectoryEntry } from '../board/ports';

const MATCH_WIDTH = 100;

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const clip = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

/** How a hit is cited: `&F303` for a card, `!A3` for an agenda item. */
export const hitReference = (hit: WorkHit): string => `${hit.kind === 'task' ? '&' : '!'}${hit.id}`;

/** The command that updates a hit its caller owns, instead of filing a second one. */
function ownCommand(hit: WorkHit, binary: string): string {
  return hit.kind === 'task' ? `${binary} task note ${hit.id}` : `${binary} agenda edit ${hit.id}`;
}

/** A session by its short id and callsign, the way `fy ps` introduces it: `mvgt2oz9 lizzette`. */
function sessionLabel(sessionId: string, directory: readonly SessionDirectoryEntry[]): string {
  const short = sessionId.split('-')[0] ?? sessionId;
  const callsign = directory.find(entry => entry.id === sessionId)?.callsign;
  return callsign === undefined ? short : `${short} ${callsign}`;
}

/** Where the work stands, in the words its owner sees; an agenda item also says whose ledger it is in. */
function standingOf(hit: WorkHit, directory: readonly SessionDirectoryEntry[]): string {
  return hit.kind === 'agenda' ? `${hit.standing} (${sessionLabel(hit.sessionId, directory)})` : hit.standing;
}

/** The matched line, unless it only repeats the title or the id the reader already sees. */
export function matchLine(hit: WorkHit): string {
  if (hit.match.field === 'id' || hit.match.field === 'title') return '';
  const line = flat(hit.match.line);
  return line === '' || line === flat(hit.title) ? '' : clip(line, MATCH_WIDTH);
}

export interface HitRenderContext {
  readonly directory: readonly SessionDirectoryEntry[];
  /** The session the caller acts as; its own work is labelled with the command that updates it. */
  readonly own: string | undefined;
  readonly binary: string;
}

/** Hits as aligned lines: `&F303  task    In progress   Title — the matching line`. */
export function renderHits(hits: readonly WorkHit[], context: HitRenderContext): string[] {
  const rows = hits.map(hit => ({
    hit,
    ref: hitReference(hit),
    kind: hit.kind,
    standing: standingOf(hit, context.directory),
  }));
  const refWidth = Math.max(0, ...rows.map(row => row.ref.length));
  const kindWidth = Math.max(0, ...rows.map(row => row.kind.length));
  const standingWidth = Math.max(0, ...rows.map(row => row.standing.length));
  return rows.map(({ hit, ref, kind, standing }) => {
    const match = matchLine(hit);
    const mine = context.own !== undefined && hit.sessionId === context.own;
    return [
      `${ref.padEnd(refWidth)}  ${kind.padEnd(kindWidth)}  ${standing.padEnd(standingWidth)}  ${flat(hit.title)}`,
      match === '' ? '' : ` — ${match}`,
      mine ? `  (yours — ${ownCommand(hit, context.binary)})` : '',
    ].join('');
  });
}

/** What an empty answer says, naming the kind the person asked about. */
export function renderNoMatch(query: string, kind: WorkKind | undefined): string {
  const subject = kind === 'task' ? 'cards' : kind === 'agenda' ? 'agenda items' : 'cards or agenda items';
  return `No ${subject} match “${query}”.`;
}
