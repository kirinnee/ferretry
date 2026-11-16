import { ApiError, jsonResponse, queryValue } from '@ferretry/kernel/contract';
import type { RedactionScope } from '@ferretry/kernel/contract';
import { FyEventListSchema } from '../../contract/index.ts';
import { journalEventToFyEvent } from '../lib/session/peers/reads.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

/** The most a page holds, and what an unbounded read gets: today's `MAX_EVENT_PAGE` (the replay's own page bound). */
const MAX_EVENT_PAGE = 1_000;

/** A non-negative whole number out of a query parameter; absent or empty is `undefined`, anything else a 400. */
function wholeNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ApiError(400, `query parameter "${name}" must be a non-negative integer`, 'invalid_query');
  return value;
}

/** Every string inside `value` passed through the scope's mask; the shape, the keys and the other values are kept. */
function maskStrings(value: unknown, scope: RedactionScope): unknown {
  if (typeof value === 'string') return scope.text(value);
  if (Array.isArray(value)) return value.map(item => maskStrings(item, scope));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskStrings(item, scope)]));
  return value;
}

/**
 * The per-ferret events read (R-0147, today's `GET /v1/sessions/:sessionId/events`): one page of a ferret's durable
 * history after `?after=` (that ferret's OWN sequence, so paging is exact), at most `?limit=` events. Each event's
 * `data` is masked in ONE vault open for the page, and a page that cannot be masked is refused rather than served raw.
 * It is the same journal the `GET /v1/events` socket replays, so an archived ferret's reads like any other.
 */
function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, eventSource, storeLoaded, pathFerret, mayAct } = f;
  return {
    routes: {
      'GET /v1/ferrets/:ferretId/events': async call => {
        const id = await pathFerret(call);
        // The journal carries the ferret's configuration in its lifecycle events: a ferret reads only itself and its helpers.
        mayAct(call, id);
        const after = wholeNumber(queryValue(call.request, 'after'), 'after') ?? 0;
        const limit = Math.min(
          wholeNumber(queryValue(call.request, 'limit'), 'limit') ?? MAX_EVENT_PAGE,
          MAX_EVENT_PAGE,
        );
        await storeLoaded.catch(() => undefined);
        const stored = await eventSource.replay(id, after, limit, new AbortController().signal);
        const page = stored.map(journalEventToFyEvent);
        // Nothing after the cursor is the answer an idle poll gets almost every time: no vault is opened for it.
        if (page.length === 0) return jsonResponse([]);
        const masked = await kernel.redaction.read(scope =>
          page.map(event => ({ ...event, data: maskStrings(event.data, scope) })),
        );
        return jsonResponse(FyEventListSchema.parse(masked));
      },
    },
  };
}

export default { id: 'ferret-events', register } satisfies FerretsFeature;
