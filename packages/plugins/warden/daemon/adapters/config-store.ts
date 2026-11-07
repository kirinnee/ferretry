import type { ConfigPort } from '@ferretry/kernel/contract';
import { WARDEN_CONFIG, effectiveWardenConfig, type WardenFile } from '../../contract/index.ts';
import { type ConfigDoor, configDoorOf } from '../lib/config-door.ts';
import type { WardenConfig, WardenConfigPatch, WardenConfigStore } from '../lib/index.ts';

/** `warden.yaml` cannot be written here (the host gives no write door), or the kernel refused the edit. */
export class WardenConfigRefused extends Error {
  constructor(
    readonly kind: 'unavailable' | 'refused',
    message: string,
  ) {
    super(message);
    this.name = 'WardenConfigRefused';
  }
}

const SECTIONS = [
  'revive',
  'autoMove',
  'layers',
  'guard',
  'caps',
  'mayActAlone',
  'jevActs',
  'events',
  'investigation',
  'failover',
  'providerOutage',
] as const;

/**
 * The settings, read from `config/warden.yaml` as the kernel has them in effect (the last good version) and written
 * through the kernel's config door, which checks the schema, keeps the comments and HOLDS a loosening for the owner.
 */
export class ConfigWardenConfigStore implements WardenConfigStore {
  private readonly door: ConfigDoor | undefined;

  constructor(private readonly config: ConfigPort) {
    this.door = configDoorOf(config);
  }

  async read(): Promise<unknown> {
    return effectiveWardenConfig(this.config.file(WARDEN_CONFIG) ?? {});
  }

  async write(_config: WardenConfig, patch: WardenConfigPatch): Promise<readonly string[]> {
    if (this.door === undefined)
      throw new WardenConfigRefused('unavailable', 'This host does not let the warden change warden.yaml yet.');
    const file = (this.config.file(WARDEN_CONFIG) ?? {}) as WardenFile;
    const keys: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if ((SECTIONS as readonly string[]).includes(key) && typeof value === 'object' && value !== null)
        keys[key] = { ...((file as Record<string, object | undefined>)[key] ?? {}), ...value };
      else keys[key] = value;
    }
    const result = await this.door.write(WARDEN_CONFIG, undefined, { patch: keys });
    if (result.kind === 'refused')
      throw new WardenConfigRefused('refused', result.issues.map(issue => issue.message).join('; ') || result.reason);
    return result.kind === 'held' ? result.sentences : [];
  }
}
