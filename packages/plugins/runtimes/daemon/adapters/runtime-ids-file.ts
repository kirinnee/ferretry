import { parseRuntimeIds, type RuntimeIds } from '../lib/account/ids.ts';
import type { AccountInventoryPort, RuntimeNamesPort } from '../lib/service/publication.ts';
import type { HostFiles } from './ports.ts';

/**
 * The fleet's `ids.json` (docs/design/account-model.md R6), read so a start can resolve a runtime by
 * a name it had before.
 *
 * Absent answers `undefined` — a machine no apply has published to has none, and nothing about it is wrong. Present
 * and unreadable THROWS, naming the file, so the start that needed it refuses rather than reporting
 * a runtime that exists as one that does not.
 */
export class RuntimeIdsFile implements RuntimeNamesPort {
  constructor(
    private readonly files: Pick<HostFiles, 'readText'>,
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
 *
 * @pending runtimes: has no apply to guard until the config write port exists
 */
export class RuntimeAwareAccountInventory<Account> implements AccountInventoryPort<Account>, RuntimeNamesPort {
  constructor(
    private readonly inventory: AccountInventoryPort<Account>,
    private readonly names: RuntimeNamesPort,
  ) {}

  async accounts(): Promise<readonly Account[]> {
    return await this.inventory.accounts();
  }

  async ids(): Promise<RuntimeIds | undefined> {
    return await this.names.ids();
  }
}
