import type { ConfigPort } from '@ferretry/kernel/contract';
import { WARDEN_CONFIG, effectiveWardenConfig, type WardenFile } from '../../contract/index.ts';
import type { WardenConfig, WardenConfigPatch, WardenConfigStore } from '../lib/index.ts';

/** The kernel refused the edit of `warden.yaml` (its sentences never quote a value). */
export class WardenConfigRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WardenConfigRefused';
  }
}

/**
 * `warden.yaml` already holds an edit waiting for the owner, so this save is refused before anything is written: the
 * held edit stays held and the settings in effect stay as they are.
 *
 * DECLARED GAP: today the owner's own save is made to BOTH versions (the one in effect and the held one), so a
 * tightening applies at once and a held edit is neither lost nor put into effect (docs/config-files.md rule 3). The
 * kernel's ConfigPort offers no owner-acknowledged write, so a plain write over a held edit patches the disk text: Gate's
 * judgeConfigWrite then judges the WHOLE patched file, so it would either hold the owner's tightening too or, where the
 * judge lets the owner's call apply, put the held edit into effect with it; and a section rewritten from the version in
 * effect would drop the held edit without a word. Refusing is the fail-safe until the kernel offers that write.
 */
export class WardenConfigHeld extends Error {
  constructor() {
    super('warden.yaml has a change waiting for your approval; confirm or discard it first, then save again.');
    this.name = 'WardenConfigHeld';
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
 * through the kernel's config write port, which checks the schema, refuses a raw secret, keeps the comments and HOLDS a
 * loosening for the owner unless Gate's judge lets this call put it into effect. A save while another edit is held is
 * refused (`WardenConfigHeld`) and writes nothing.
 */
export class ConfigWardenConfigStore implements WardenConfigStore {
  constructor(private readonly config: ConfigPort) {}

  async read(): Promise<unknown> {
    return effectiveWardenConfig(this.config.file(WARDEN_CONFIG) ?? {});
  }

  async write(_config: WardenConfig, patch: WardenConfigPatch): Promise<readonly string[]> {
    if (this.config.fileState(WARDEN_CONFIG).state === 'held') throw new WardenConfigHeld();
    const file = (this.config.file(WARDEN_CONFIG) ?? {}) as WardenFile;
    const keys: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if ((SECTIONS as readonly string[]).includes(key) && typeof value === 'object' && value !== null)
        keys[key] = { ...((file as Record<string, object | undefined>)[key] ?? {}), ...value };
      else keys[key] = value;
    }
    const result = await this.config.write(WARDEN_CONFIG, undefined, { patch: keys });
    if (result.kind === 'refused')
      throw new WardenConfigRefused(result.issues.map(issue => issue.message).join('; ') || result.reason);
    if (result.kind === 'conflict') throw new WardenConfigRefused('warden.yaml changed while it was being written');
    return result.kind === 'held' ? result.sentences : [];
  }
}
