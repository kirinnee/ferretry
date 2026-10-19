/**
 * Reading the models Ollama has installed, for the surfaces that show them (the provider tile, its
 * form, an Ollama login's page). ONE READ WHEN THE SURFACE OPENS, then only when a person asks again:
 * there is no timer, and a changing `createClient` identity does not re-ask — only a different machine
 * does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import type { LocalModelsRead } from '../../../lib/local-models.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { refreshLocalModels } from '../local-models-api.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';

export interface UseLocalModelsOptions {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** Whether a surface that shows the answer is open. Nothing is read while it is not. */
  readonly enabled: boolean;
}

export interface LocalModelsControl extends LocalModelsRead {
  /** A person's "Check again". */
  readonly check: () => void;
}

const UNREAD: LocalModelsRead = { snapshot: null, checking: false, error: null };

export function useLocalModels({ connection, createClient, enabled }: UseLocalModelsOptions): LocalModelsControl {
  const [read, setRead] = useState<LocalModelsRead>(UNREAD);
  const latest = useRef({ connection, createClient });
  latest.current = { connection, createClient };
  // A read that outlives its machine (or the screen) must not write into the next one.
  const epoch = useRef(0);

  const run = useCallback(async (): Promise<void> => {
    const mine = epoch.current;
    setRead(previous => ({ ...previous, checking: true, error: null }));
    try {
      const client = await latest.current.createClient(latest.current.connection);
      const snapshot = await refreshLocalModels(client);
      if (epoch.current === mine) setRead({ snapshot, checking: false, error: null });
    } catch (error) {
      if (epoch.current === mine)
        setRead(previous => ({ ...previous, checking: false, error: changeRefusalSentence(error) }));
    }
  }, []);

  const daemonId = connection.daemonId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different machine starts over; nothing else re-asks.
  useEffect(() => {
    if (!enabled) return;
    epoch.current += 1;
    setRead(UNREAD);
    void run();
    return () => {
      epoch.current += 1;
    };
  }, [daemonId, enabled, run]);

  return { ...read, check: () => void run() };
}
