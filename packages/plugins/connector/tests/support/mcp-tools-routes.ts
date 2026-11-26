import type { AgendaItem } from '@ferretry/core-asks/contract';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { DelegateRequest, DelegateResponse } from '@ferretry/kernel/contract';
import { ok, snapshot } from './mcp-fixtures.ts';
import type { Rig } from './mcp-harness.ts';

/** Fake daemon routes for the tool tests: what `GET /v1/ferrets` and `GET /v1/ferrets/:id` answer from a list of ferrets. */
export const ferretsRoute =
  (views: readonly FerretSummary[]) =>
  (call: DelegateRequest): DelegateResponse | undefined => {
    if (call.method !== 'GET') return undefined;
    if (call.path === '/v1/ferrets') return ok(views);
    const one = /^\/v1\/ferrets\/([^/]+)$/u.exec(call.path);
    if (one === null) return undefined;
    const found = views.find(view => view.id === decodeURIComponent(one[1] as string));
    return found === undefined ? undefined : ok(found);
  };

/** `GET /v1/agenda/open`: one page holding every board in `boards` (board id -> its items). */
export const openRoute =
  (boards: Record<string, readonly AgendaItem[]>) =>
  (call: DelegateRequest): DelegateResponse | undefined =>
    call.path === '/v1/agenda/open'
      ? ok({ sessions: Object.entries(boards).map(([sessionId, items]) => ({ sessionId, items })) })
      : undefined;

/** Every POST the tools sent, in order. */
export const posts = (r: Rig) => r.delegate.calls.filter(entry => entry.call.method === 'POST');

/** Any POST answers the (empty) board snapshot the daemon sends after an agenda act. */
export const answered =
  (sessionId: string) =>
  (call: DelegateRequest): DelegateResponse | undefined =>
    call.method === 'POST' ? ok(snapshot(sessionId)) : undefined;

/** A raw daemon answer with an arbitrary status and body (a refusal with no sentence, a non-JSON body …). */
export const raw = (status: number, body: string): DelegateResponse => ({ status, headers: new Map(), body });
