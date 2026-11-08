/**
 * The three catalogue reads the Profiles tab and the Model sets tab share: components, profile stacks and runtimes
 * (docs/design/account-model.md §7), made through the client bound to this machine.
 *
 * One read of all three, because every page on these tabs needs at least two of them — a component's
 * "Used by" names profiles, a profile's "Where it is used" names runtimes — and a pair of reads that
 * disagreed would count the same thing twice differently. After any change — made here, or anywhere
 * the machine says its configuration moved — the whole catalogue is read again; nothing is patched in
 * place, so what the page shows is always what the daemon answered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ComponentCatalog,
  ComponentCatalogSchema,
  type ComponentView,
  type LayeredProfileCatalog,
  LayeredProfileCatalogSchema,
  type RuntimeCatalog,
  RuntimeCatalogSchema,
} from '../../../../contract/index.ts';
import { useMachineChanges } from '../../../hooks/use-machine-changes.ts';
import { type CallFailure, callFailure, type LiveRuntimesClient, type RuntimesClient } from '../../../lib/client.ts';

const COMPONENTS_ROUTE = 'GET /v1/runtimes/components' as const;
const PROFILES_ROUTE = 'GET /v1/runtimes/profiles' as const;
const RUNTIMES_ROUTE = 'GET /v1/runtimes' as const;

/** The six kinds, each component with its badges and "used by". */
export const readComponents = async (client: RuntimesClient): Promise<ComponentCatalog> =>
  ComponentCatalogSchema.parse(await client.call(COMPONENTS_ROUTE));

/** Every profile with its layers, its stack per harness and its conflicts. */
export const readProfiles = async (client: RuntimesClient): Promise<LayeredProfileCatalog> =>
  LayeredProfileCatalogSchema.parse(await client.call(PROFILES_ROUTE));

/** Each runtime with its resolved stack, model set, fixed layer and whether it can launch. */
export const readRuntimeCatalog = async (client: RuntimesClient): Promise<RuntimeCatalog> =>
  RuntimeCatalogSchema.parse(await client.call(RUNTIMES_ROUTE));

export interface AccountCatalog {
  readonly components: ComponentCatalog;
  readonly profiles: LayeredProfileCatalog;
  readonly runtimes: RuntimeCatalog;
}

export type AccountCatalogRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: AccountCatalog }
  /** It answered with a refusal, or did not answer: the sentence says which. */
  | { readonly kind: 'failed'; readonly reason: string };

/** The daemon answered with a refusal: a status and a code, which the shell's client puts on what it throws. */
const refusal = (error: unknown): (CallFailure & { readonly message: string }) | null => {
  const failure = callFailure(error);
  return failure !== null && typeof failure.status === 'number' && typeof failure.message === 'string'
    ? (failure as CallFailure & { readonly message: string })
    : null;
};

/** One read of all three; never throws. */
async function readAccountCatalog(client: RuntimesClient): Promise<AccountCatalogRead> {
  try {
    const [components, profiles, runtimes] = await Promise.all([
      readComponents(client),
      readProfiles(client),
      readRuntimeCatalog(client),
    ]);
    return { kind: 'ready', catalog: { components, profiles, runtimes } };
  } catch (error) {
    const refused = refusal(error);
    return {
      kind: 'failed',
      reason:
        refused !== null
          ? `This machine answered but did not share its setup: ${refused.message}`
          : 'This machine did not answer, so its setup cannot be shown right now.',
    };
  }
}

/** Every component, across the six kinds. */
export const allComponents = (catalog: AccountCatalog): readonly ComponentView[] =>
  catalog.components.kinds.flatMap(group => group.components);

export interface UseAccountCatalog {
  readonly read: AccountCatalogRead;
  /** Read again; answers the new read so a caller can pick what it just made. */
  readonly reload: () => Promise<AccountCatalogRead>;
}

/** The catalogue for one machine, read on mount and on demand. A newer read always wins. */
export function useAccountCatalog(client: LiveRuntimesClient): UseAccountCatalog {
  const [read, setRead] = useState<AccountCatalogRead>({ kind: 'loading' });
  const generation = useRef(0);
  const reload = useCallback(async (): Promise<AccountCatalogRead> => {
    generation.current += 1;
    const mine = generation.current;
    const next = await readAccountCatalog(client);
    if (mine === generation.current) setRead(next);
    return next;
  }, [client]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Changed anywhere else and read again; a re-read that fails keeps the catalogue on screen.
  useMachineChanges(client, ['runtimes', 'catalogue'], () => {
    generation.current += 1;
    const mine = generation.current;
    void readAccountCatalog(client).then(next => {
      if (mine === generation.current && next.kind === 'ready') setRead(next);
    });
  });
  return { read, reload };
}
