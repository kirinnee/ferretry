import { FleetCatalogRefusal, type ExecutorCaller } from './catalog-service.ts';
import { configurationLanded } from './failed-apply.ts';
import { ConfigWriteConflict, ConfigWriteInvalid } from './ports.ts';
import type { CloneConfigFiles } from './setup-service.ts';

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

/** One settings file through `PUT /v1/config/file`'s semantics. Answers 1 when the write was held. */
export async function putConfigFile(
  write: {
    readonly path: string;
    readonly text: string;
    readonly etag: string;
    readonly put: CloneConfigFiles['write'];
  },
  mayLoosen: boolean,
): Promise<number> {
  try {
    return (await write.put(write.path, write.text, write.etag, mayLoosen)).outcome === 'pending' ? 1 : 0;
  } catch (error) {
    if (error instanceof ConfigWriteConflict) {
      throw new FleetCatalogRefusal(
        'fleet_change_stale',
        `${write.path} changed on this machine after it was reviewed; review it again`,
      );
    }
    if (error instanceof ConfigWriteInvalid) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        `${write.path} would not check on this machine, so it was not written: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}

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
