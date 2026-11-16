/**
 * Reading the models Ollama has installed, for the surfaces that show them. ONE READ WHEN THE SURFACE OPENS, then only
 * when a person asks again: there is no timer. The shell builds this half once per daemon, so a different machine is a
 * different client and starts over.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { refusalSentence, type LoginsClient } from '../lib/client.ts';
import type { LocalModelsRead } from '../lib/local-models.ts';
import { refreshLocalModels } from '../lib/local-models-api.ts';

export interface UseLocalModelsOptions {
  readonly client: LoginsClient;
  /** Whether a surface that shows the answer is open. Nothing is read while it is not. */
  readonly enabled: boolean;
}

export interface LocalModelsControl extends LocalModelsRead {
  /** A person's "Check again". */
  readonly check: () => void;
}

const UNREAD: LocalModelsRead = { snapshot: null, checking: false, error: null };

export function useLocalModels({ client, enabled }: UseLocalModelsOptions): LocalModelsControl {
  const [read, setRead] = useState<LocalModelsRead>(UNREAD);
  const latest = useRef(client);
  latest.current = client;
  // A read that outlives its surface must not write into the next one.
  const epoch = useRef(0);

  const run = useCallback(async (): Promise<void> => {
    const mine = epoch.current;
    setRead(previous => ({ ...previous, checking: true, error: null }));
    try {
      const snapshot = await refreshLocalModels(latest.current);
      if (epoch.current === mine) setRead({ snapshot, checking: false, error: null });
    } catch (error) {
      if (epoch.current === mine)
        setRead(previous => ({ ...previous, checking: false, error: refusalSentence(error) }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    epoch.current += 1;
    setRead(UNREAD);
    void run();
    return () => {
      epoch.current += 1;
    };
  }, [enabled, run]);

  return { ...read, check: () => void run() };
}
