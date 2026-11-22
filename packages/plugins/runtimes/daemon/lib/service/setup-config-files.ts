import { FleetCatalogRefusal, type ExecutorCaller } from './catalog-service.ts';
import { configurationLanded } from './failed-apply.ts';

/**
 * The import's settings files, one at a time through the owner's door. Answers how many were held for the owner.
 *
 * A request that has ended stops the apply BEFORE each write (`live()`). `landed` collects the files that really landed
 * (a held one did not), so a later failure can say they are on disk.
 */
export async function writeConfigFiles<Write extends { readonly path: string }>(
  writes: readonly Write[],
  writeOne: (write: Write) => Promise<number>,
  caller: ExecutorCaller | undefined,
  landed: string[],
): Promise<number> {
  let held = 0;
  for (const write of writes) {
    caller?.live?.();
    try {
      const waiting = await writeOne(write);
      held += waiting;
      if (waiting === 0) landed.push(write.path);
    } catch (error) {
      if (landed.length > 0 && error instanceof FleetCatalogRefusal) {
        throw new FleetCatalogRefusal(error.code, `${error.message}; ${configurationLanded(landed)}`);
      }
      throw error;
    }
  }
  return held;
}
