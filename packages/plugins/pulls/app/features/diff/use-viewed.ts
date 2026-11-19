import { useCallback, useState } from 'react';
import type { PullFile } from '../../../contract/index.ts';
import { deviceStorage, readTicks, viewedKey, writeTicks } from './viewed.ts';

/** This device's "viewed" ticks for one PR (`scope`), kept in the browser's own storage. */
export function useViewedTicks(scope: string) {
  const [held, setHeld] = useState(() => ({ scope, ticks: readTicks(deviceStorage(), scope) }));
  const ticks = held.scope === scope ? held.ticks : readTicks(deviceStorage(), scope);
  const isViewed = useCallback((file: PullFile) => ticks.has(viewedKey(file)), [ticks]);
  const setViewed = useCallback(
    (file: PullFile, viewed: boolean) => {
      const next = new Set(ticks);
      if (viewed) next.add(viewedKey(file));
      else next.delete(viewedKey(file));
      writeTicks(deviceStorage(), scope, next);
      setHeld({ scope, ticks: next });
    },
    [scope, ticks],
  );
  return { isViewed, setViewed } as const;
}
