import type { WorkHit, WorkKind, WorkSearchResponse } from '../../../contract/index.ts';

/**
 * The hits as a model reads them (today's `search_work` MCP rendering): one line each, with its reference, kind,
 * standing, title, then the matching line. The CLI has its own aligned rendering; this is the agent tool's text.
 */

const MATCH_WIDTH = 100;

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const clip = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

/** How a hit is cited: `&F303` for a card, `!A3` for an ask. */
const hitReference = (hit: WorkHit): string => `${hit.kind === 'card' ? '&' : '!'}${hit.id}`;

/** The matching line of a hit, when it says something the title does not. */
function matchLine(hit: WorkHit): string {
  if (hit.match.field === 'id' || hit.match.field === 'title') return '';
  const line = flat(hit.match.line);
  return line === '' || line === flat(hit.title) ? '' : clip(line, MATCH_WIDTH);
}

function renderOlderHidden(olderHidden: number | undefined, retry: string): string[] {
  if (olderHidden === undefined || olderHidden < 1) return [];
  const noun = olderHidden === 1 ? 'older closed item' : 'older closed items';
  return [`${String(olderHidden)} ${noun} hidden — ${retry}`];
}

/** What an empty answer says, naming the kind the person asked about. */
function renderNoMatch(query: string, kind: WorkKind | undefined): string {
  const subject = kind === 'card' ? 'cards' : kind === 'ask' ? 'asks' : 'cards or asks';
  return `No ${subject} match “${query}”.`;
}

export function renderSearch(query: string, kind: WorkKind | undefined, answer: WorkSearchResponse): string {
  const older = renderOlderHidden(answer.olderHidden, 'search_work again with all: true');
  if (answer.hits.length === 0) return [renderNoMatch(query, kind), ...older].join('\n');
  const lines = answer.hits.map(hit => {
    const match = matchLine(hit);
    const owner = hit.kind === 'ask' ? ` (ask of ${hit.ferret})` : '';
    return `${hitReference(hit)} ${hit.kind} [${hit.standing}]${owner} ${hit.title}${match === '' ? '' : ` — ${match}`}`;
  });
  const more =
    answer.total > answer.hits.length
      ? [`(${String(answer.hits.length)} of ${String(answer.total)} shown; narrow it with kind or open)`]
      : [];
  return [...lines, ...more, ...older].join('\n');
}
