import { readFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { z } from 'zod';

/** Linux MemAvailable includes reclaimable caches; freemem alone spuriously refuses a healthy host. */
export async function availableVoiceMemory(platform: string = process.platform): Promise<number> {
  if (platform !== 'linux') return freemem();
  const text = await readFile('/proc/meminfo', 'utf8');
  return (
    z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(/^MemAvailable:\s+(\d+) kB$/mu.exec(text)?.[1]) * 1024
  );
}
