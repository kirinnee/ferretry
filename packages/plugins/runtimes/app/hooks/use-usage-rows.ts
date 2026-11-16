/** Read this daemon's quota rows once, and again when Usage says a login was paused or resumed. */

import { LoginPaused, LoginResumed } from '@ferretry/plugin-usage/contract';
import { useEffect, useState } from 'react';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { NO_USAGE, type UsageRows, readUsageRows } from '../lib/usage-feed.ts';

export const useUsageRows = (client: LiveRuntimesClient): UsageRows => {
  const [read, setRead] = useState<UsageRows>(NO_USAGE);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      void readUsageRows(client).then(rows => {
        if (live) setRead(rows);
      });
    };
    load();
    const stops = [client.subscribe?.(LoginPaused, load), client.subscribe?.(LoginResumed, load)];
    return () => {
      live = false;
      for (const stop of stops) stop?.();
    };
  }, [client]);
  return read;
};
