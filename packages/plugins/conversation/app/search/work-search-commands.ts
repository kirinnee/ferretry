/**
 * WORK SEARCH IN THE COMMAND BAR (lead decision Q10): the cards and asks the daemon's body-text index finds for what the
 * reader typed, as entries of the shell's command bar. Today's palette asked `GET /v1/search` itself; the shell holds
 * no feature now, so Conversation contributes this source (`shell.commands`) and the bar lists it beside its own.
 *
 * Today's rules hold: one request per pause in typing (`WORK_SEARCH_DEBOUNCE_MS`), a new request abandons the one in
 * flight, and THE LAST ANSWER STAYS while the next loads, so the rows a reader was about to pick never vanish under
 * their pointer. The source is built per daemon, so one machine's cards are never offered under another's name.
 */

import type { CommandBarAnswer, CommandBarEntry, CommandBarFilter } from '@ferretry/app/ui';
import type { PluginCommandContext } from '@ferretry/app';
import { formatReference } from '@ferretry/app';
import type { WorkHit, WorkKind, WorkSearchResponse } from '../../contract/index.ts';
import {
  WORK_SEARCH_DEBOUNCE_MS,
  WORK_SEARCH_MIN_LENGTH,
  type WorkSearchPort,
  workHitDescription,
  workHitKey,
  workProjectLabel,
  workSearchPort,
} from './work-search.ts';

/** How many hits one search asks for (today's palette asked the same). */
export const WORK_SEARCH_LIMIT = 20;

/** The most rows of each kind the bar lists (today's palette showed six of each while both kinds were listed). */
export const MAX_WORK_ROWS_PER_KIND = 6;

/** The words the bar shows while the daemon's search is still out (today's palette said the same). */
export const WORK_PENDING_LINE = 'Searching cards and agenda…';

/**
 * The chips the bar draws for this source (S11), as today's palette drew them: which kind, and whether closed work is
 * among the answer. The first option of each is the resting one: everything, so a finished card is still findable.
 */
export const WORK_FILTERS: readonly CommandBarFilter[] = [
  {
    id: 'kind',
    label: 'Kind of work',
    options: [
      { id: 'all', label: 'All' },
      { id: 'card', label: 'Cards' },
      { id: 'ask', label: 'Agenda' },
    ],
  },
  {
    id: 'state',
    label: 'State of work',
    options: [
      { id: 'everything', label: 'Everything' },
      { id: 'open', label: 'Open' },
    ],
  },
];

/** The heading each kind is listed under. */
export const WORK_GROUPS = { card: 'Cards', ask: 'Asks' } as const;

/** Where Enter on a hit goes: the card's screen, or the ask in the Agenda. `undefined` when no plugin draws it. */
export const workHitHref = (hit: WorkHit, context: Pick<PluginCommandContext, 'daemon' | 'screenHref'>) =>
  hit.kind === 'card'
    ? context.screenHref(context.daemon, 'board', 'card', { id: hit.id })
    : context.screenHref(context.daemon, 'agenda', 'agenda-ask', { ferret: hit.ferret, ask: hit.id });

/**
 * One hit as a bar entry. The query it answered is among its keywords: the daemon already matched it in the body text,
 * which the bar's own ranking cannot see, so a hit found in a note is not ranked away.
 */
export const workHitEntry = (
  hit: WorkHit,
  query: string,
  context: Pick<PluginCommandContext, 'daemon' | 'screenHref' | 'navigate'>,
): CommandBarEntry | undefined => {
  const href = workHitHref(hit, context);
  if (href === undefined) return undefined;
  const reference = formatReference(
    hit.kind === 'card' ? { kind: 'task', id: hit.id } : { kind: 'attention', id: hit.id },
  );
  const matched = workHitDescription(hit);
  // The project a card is filed under, as today's palette named it under the row ('Unfiled', or nothing for a project
  // whose name this source does not have). GAP: the project names and an ask's owner need the Board's and Ferrets'
  // lists, which no contract hands this source yet (app/NEEDS-APP-SHELL.txt).
  const project = hit.kind === 'card' ? workProjectLabel(hit.project, undefined) : '';
  const description = [hit.standing, matched].filter(part => part !== '').join(' · ');
  return {
    id: `work-${workHitKey(hit)}`,
    group: WORK_GROUPS[hit.kind],
    label: `${reference} ${hit.title}`,
    description,
    // The second line under the row (S11); empty draws nothing.
    ...(project === '' ? {} : { detail: project }),
    // Closed, dropped or addressed work is muted, not hidden: it answers "did we already do this?".
    ...(hit.state === 'open' ? {} : { muted: true }),
    keywords: [query.trim(), hit.id],
    run: () => context.navigate(href),
  };
};

/**
 * The bar's work-search source over one daemon. `port` and the timers are injectable so a suite drives it without a
 * daemon or a clock.
 */
export function workSearchCommandSource(
  context: PluginCommandContext,
  options: {
    readonly port?: WorkSearchPort;
    readonly debounceMs?: number;
    readonly schedule?: (run: () => void, delayMs: number) => () => void;
  } = {},
): {
  readonly filters: readonly CommandBarFilter[];
  readonly list: (query: string, filters: Readonly<Record<string, string>>) => CommandBarAnswer;
} {
  const port = options.port ?? workSearchPort(context.client);
  const debounceMs = options.debounceMs ?? WORK_SEARCH_DEBOUNCE_MS;
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  /** What the last search was asked: the words and the chips. */
  let asked: string | null = null;
  let cancel: (() => void) | undefined;
  /** The words and chips whose search failed: not pending any more. */
  let failed: string | null = null;
  let answer: { readonly key: string; readonly query: string; readonly response: WorkSearchResponse } | null = null;

  const ask = (query: string, kind: WorkKind | undefined, open: boolean, key: string): void => {
    cancel?.();
    const controller = new AbortController();
    const unschedule = schedule(() => {
      // "Everything" also lifts the daemon's 30-day window; "Open" has no closed work to window (today's palette).
      port
        .search(
          { q: query, ...(kind === undefined ? {} : { kind }), open, all: !open, limit: WORK_SEARCH_LIMIT },
          controller.signal,
        )
        .then(
          response => {
            if (controller.signal.aborted) return;
            answer = { key, query, response };
            context.changed();
          },
          () => {
            // A failed search keeps the last good answer on screen; the bar's own entries stand regardless. It is no
            // longer "searching", so the bar is asked to list again without that line.
            if (controller.signal.aborted) return;
            failed = key;
            context.changed();
          },
        );
    }, debounceMs);
    cancel = () => {
      unschedule();
      controller.abort();
    };
  };

  return {
    filters: WORK_FILTERS,
    list: (query, filters): CommandBarAnswer => {
      const trimmed = query.trim();
      if (trimmed.length < WORK_SEARCH_MIN_LENGTH) {
        cancel?.();
        cancel = undefined;
        asked = null;
        return { entries: [] };
      }
      const kind = filters.kind === 'card' || filters.kind === 'ask' ? filters.kind : undefined;
      const open = filters.state === 'open';
      const key = `${trimmed}\u0000${kind ?? ''}\u0000${open}`;
      if (key !== asked) {
        asked = key;
        ask(trimmed, kind, open, key);
      }
      // Still out for these words and chips: say so; the rows of the last answer stay meanwhile.
      const pending = answer?.key === key || failed === key ? {} : { pending: WORK_PENDING_LINE };
      if (answer === null) return { entries: [], ...pending };
      const shown = answer;
      const listed = { card: 0, ask: 0 };
      // One kind alone shows all the daemon returned; while both are listed each is capped (today's palette).
      const capped = kind === undefined;
      const entries = shown.response.hits.flatMap(hit => {
        if (capped && listed[hit.kind] >= MAX_WORK_ROWS_PER_KIND) return [];
        const entry = workHitEntry(hit, shown.query, context);
        if (entry === undefined) return [];
        listed[hit.kind] += 1;
        return [entry];
      });
      return { entries, ...pending };
    },
  };
}
