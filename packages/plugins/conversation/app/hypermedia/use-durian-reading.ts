import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { createDurianReader, type DurianReader, type Reading, type Slot } from './durian-reader.ts';
import { spawnDurianWorker } from './durian-spawn.ts';

/**
 * The reader a message is read through: the page's one (made on first use, over the real worker), or the one a provider
 * hands down (a test gives one over a worker of its own, or none).
 */
export const DurianReaderContext = createContext<DurianReader | null>(null);

let shared: DurianReader | undefined;
const sharedReader = (): DurianReader => {
  shared ??= createDurianReader({ spawn: spawnDurianWorker });
  return shared;
};

/**
 * WHAT A MESSAGE IS NOW: pending (the plain text is drawn), read (the document is drawn) or plain text with its note. The
 * answer for a message that was read before comes at once, from the cache, so scrolling back to it never blinks; a new one is
 * asked for after the first paint (never during a render), and the latest text of a streaming message is the one asked for.
 */
export function useDurianReading(source: string, arriving: boolean): Reading {
  const reader = useContext(DurianReaderContext) ?? sharedReader();
  const slot = useRef<Slot | null>(null);
  slot.current ??= reader.slot();
  const mine = slot.current;
  const reading = useSyncExternalStore(
    reader.subscribe,
    () => reader.snapshot(mine, source, arriving),
    () => reader.snapshot(mine, source, arriving),
  );
  useEffect(() => {
    reader.want(mine, source, arriving);
  }, [reader, mine, source, arriving]);
  useEffect(() => () => reader.release(mine), [reader, mine]);
  return reading;
}
