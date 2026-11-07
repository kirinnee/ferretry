/**
 * WHETHER THIS MACHINE HAS NO RUNTIME, so the empty Sessions list can say what to do about it.
 *
 * It claims nothing until the machine has answered: an unread or unreachable machine is "unknown",
 * never "needs one". It reads again whenever the machine's runtimes or default move, so creating one
 * (here or from another device) clears the prompt without a reload.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimesChanged, RuntimesDefaultChanged } from '../../contract/index.ts';
import { readNeedsRuntime } from '../lib/runtimes-api.ts';

export function useNeedsRuntime(client: Pick<PluginClient, 'call' | 'subscribe'> | undefined): boolean {
  const [needs, setNeeds] = useState(false);
  const live = useRef(true);
  const current = useRef(client);
  current.current = client;

  const read = useCallback(() => {
    if (client === undefined) return;
    void readNeedsRuntime(client).then(answer => {
      if (live.current && current.current === client && answer !== undefined) setNeeds(answer);
    });
  }, [client]);

  useEffect(() => {
    live.current = true;
    setNeeds(false);
    read();
    return () => {
      live.current = false;
    };
  }, [read]);

  useEffect(() => {
    if (client === undefined) return;
    const stops = [client.subscribe(RuntimesChanged, read), client.subscribe(RuntimesDefaultChanged, read)];
    return () => {
      for (const stop of stops) stop();
    };
  }, [client, read]);
  return needs;
}
