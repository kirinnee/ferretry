import { parseRuntimeIds, type RuntimeIds } from '@ferretry/fleet';
import type { RuntimeNamesPort } from '../../lib/fleet/start-resolution.ts';
import type { AccountInventoryPort, CoreAccount, FileSystemPort } from '../../lib/index.ts';

/**
 * The fleet's `ids.json` (docs/design/account-model.md R6), read so a start can resolve a runtime by
 * a name it had before.
 *
 * Absent answers `undefined` — a version-1 fleet has none, and nothing about it is wrong. Present
 * and unreadable THROWS, naming the file, so the start that needed it refuses rather than reporting
 * a runtime that exists as one that does not.
 */
export class RuntimeIdsFile implements RuntimeNamesPort {
  constructor(
    private readonly files: FileSystemPort,
    private readonly path: string,
  ) {}

  async ids(): Promise<RuntimeIds | undefined> {
    const text = await this.files.readText(this.path);
    if (text === undefined) return undefined;
    try {
      return parseRuntimeIds(JSON.parse(text));
    } catch (error) {
      throw new Error(`${this.path} could not be read: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
}

/**
 * The fleet's account inventory with its runtime names beside it: the ONE inventory a daemon shares,
 * so every start resolves an old wrapper name without any call site passing a second thing.
 */
export class RuntimeAwareAccountInventory implements AccountInventoryPort, RuntimeNamesPort {
  constructor(
    private readonly inventory: AccountInventoryPort,
    private readonly names: RuntimeNamesPort,
  ) {}

  async accounts(): Promise<readonly CoreAccount[]> {
    return await this.inventory.accounts();
  }

  async ids(): Promise<RuntimeIds | undefined> {
    return await this.names.ids();
  }
}
