/**
 * THE FLEET THE CHAT PROVES `:agent` AGAINST: this daemon's ferrets (`GET /v1/ferrets`), each as the one rule that
 * addresses a ferret by id or callsign reads it (Ferrets' contract owns that rule), plus the folder each works in, which
 * is what an absolute `@file` path is made relative to.
 *
 * `undefined` means NOT READ YET (or refused): an unread fleet is not a fleet with nobody in it, so nothing is proved from
 * it. The value keeps its identity until a fact the proof reads changes (an id, a callsign, a folder, a ferret going
 * live or dormant), so a status tick never rebuilds the reference surface and re-parses every message.
 */

import { type AgentAddressCandidate, FerretsChanged } from '@ferretry/core-ferrets/contract';
import { browserListRefreshEnvironment, ListRefresh } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import { z } from 'zod';

export interface ChatFleet {
  readonly candidates: readonly AgentAddressCandidate[];
  /** Ferret id to the folder it works in. */
  readonly folders: ReadonlyMap<string, string>;
}

/** The only fields the proof reads; a row of another shape is left out, never trusted. */
const RowSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.string(),
  folder: z.string(),
});

/** The fleet a list answer describes, or `undefined` when the answer is not a list. */
export const chatFleetOf = (body: unknown): ChatFleet | undefined => {
  if (!Array.isArray(body)) return undefined;
  const rows = body.flatMap(row => {
    const parsed = RowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    candidates: rows.map(row => ({ id: row.id, name: row.name, status: row.state })),
    folders: new Map(rows.map(row => [row.id, row.folder])),
  };
};

/** A key over exactly the facts the proof reads: equal keys mean the surface need not be rebuilt. */
export const chatFleetKey = (fleet: ChatFleet | undefined): string =>
  fleet === undefined
    ? ''
    : JSON.stringify(fleet.candidates.map(c => [c.id, c.name, c.status])) + JSON.stringify([...fleet.folders]);

/** How soon a change is read again: quick enough to feel live, slow enough that a burst is one read. */
const REFRESH_MIN_MS = 1_000;

export const useChatFleet = (
  client: Pick<PluginClient, 'call'> & Partial<Pick<PluginClient, 'subscribe'>>,
): ChatFleet | undefined => {
  const [held, setHeld] = useState<{ readonly key: string; readonly fleet: ChatFleet | undefined }>({
    key: '',
    fleet: undefined,
  });
  useEffect(() => {
    let live = true;
    const refresh = new ListRefresh(
      async () => {
        const fleet = chatFleetOf(await client.call<unknown>('GET /v1/ferrets'));
        if (live)
          setHeld(current => (current.key === chatFleetKey(fleet) ? current : { key: chatFleetKey(fleet), fleet }));
      },
      browserListRefreshEnvironment,
      REFRESH_MIN_MS,
    );
    void refresh.request().catch(() => undefined);
    const stop = client.subscribe?.(FerretsChanged, () => void refresh.invalidate().catch(() => undefined));
    return () => {
      live = false;
      stop?.();
      refresh.stop();
    };
  }, [client]);
  return held.fleet;
};
