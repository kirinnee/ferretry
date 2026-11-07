/**
 * WORK SEARCH IN THE COMMAND BAR (lead decision Q10): the cards and asks the daemon's body-text index finds for what the
 * reader typed, as entries of the shell's command bar. Today's palette asked `GET /v1/search` itself; the shell holds
 * no feature now, so Conversation contributes this source (`shell.commands`) and the bar lists it beside its own.
 *
 * Today's rules hold: one request per pause in typing (`WORK_SEARCH_DEBOUNCE_MS`), a new request abandons the one in
 * flight, and THE LAST ANSWER STAYS while the next loads, so the rows a reader was about to pick never vanish under
 * their pointer. The source is built per daemon, so one machine's cards are never offered under another's name.
 */

import type { CommandBarEntry, CommandBarSource } from '@ferretry/app/ui';
import type { PluginCommandContext } from '@ferretry/app';
import { formatReference } from '@ferretry/app';
import type { WorkHit, WorkSearchResponse } from '../../contract/index.ts';
import {
  WORK_SEARCH_DEBOUNCE_MS,
  WORK_SEARCH_MIN_LENGTH,
  type WorkSearchPort,
  workHitDescription,
  workHitKey,
  workSearchPort,
} from './work-search.ts';

/** How many hits one search asks for (today's palette asked the same). */
export const WORK_SEARCH_LIMIT = 20;

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
  const description = workHitDescription(hit);
  return {
    id: `work-${workHitKey(hit)}`,
    group: WORK_GROUPS[hit.kind],
    label: `${reference} ${hit.title}`,
    description: description === '' ? hit.standing : `${hit.standing} · ${description}`,
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
): CommandBarSource {
  const port = options.port ?? workSearchPort(context.client);
  const debounceMs = options.debounceMs ?? WORK_SEARCH_DEBOUNCE_MS;
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  let asked: string | null = null;
  let cancel: (() => void) | undefined;
  let answer: { readonly query: string; readonly response: WorkSearchResponse } | null = null;

  const ask = (query: string): void => {
    cancel?.();
    const controller = new AbortController();
    const unschedule = schedule(() => {
      port.search({ q: query, limit: WORK_SEARCH_LIMIT }, controller.signal).then(
        response => {
          if (controller.signal.aborted) return;
          answer = { query, response };
          context.changed();
        },
        () => {
          // A failed search keeps the last good answer on screen; the bar's own entries stand regardless.
        },
      );
    }, debounceMs);
    cancel = () => {
      unschedule();
      controller.abort();
    };
  };

  return query => {
    const trimmed = query.trim();
    if (trimmed.length < WORK_SEARCH_MIN_LENGTH) {
      cancel?.();
      cancel = undefined;
      asked = null;
      return [];
    }
    if (trimmed !== asked) {
      asked = trimmed;
      ask(trimmed);
    }
    if (answer === null) return [];
    const shown = answer;
    return shown.response.hits.flatMap(hit => {
      const entry = workHitEntry(hit, shown.query, context);
      return entry === undefined ? [] : [entry];
    });
  };
}
