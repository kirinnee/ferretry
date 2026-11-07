import type { ConfigPort } from '@ferretry/kernel/contract';
import { DEFAULT_WARDEN_CONFIG, WARDEN_CONFIG, effectiveWardenConfig, type WardenFile } from '../../contract/index.ts';
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
 * kernel's ConfigPort offers no owner-acknowledged write, so on 5.0:
 * - while the kernel holds an edit, the owner's save is refused (this error), never written over it;
 * - a broken file, or a hand edit the kernel has not reloaded yet, is OVERWRITTEN with the value in effect: every
 *   setting is written from the settings in effect plus the owner's patch, so such an edit is never put into effect,
 *   but it is lost (today's fail-safe);
 * - refusing a write over a file that moved since the kernel's last reload (so that hand edit is held, not lost) waits
 *   on the kernel.
 */
export class WardenConfigHeld extends Error {
  constructor() {
    super('warden.yaml has a change waiting for your approval; confirm or discard it first, then save again.');
    this.name = 'WardenConfigHeld';
  }
}

const SECTIONS: readonly string[] = [
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
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structural equality over plain JSON-shaped values. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
    return leftKeys.length === rightKeys.length && leftKeys.every(key => sameValue(left[key], right[key]));
  }
  return false;
}

/**
 * EVERY top-level key of `warden.yaml`, as `next` means it, for the kernel to patch over the disk text (today's
 * `renderConfigFile` of the whole settings). A key the version in effect states, or one whose value is not the
 * default, is written; any other is removed (`undefined`), so its default stands. A section is written whole, so a key
 * the disk has that `next` does not is removed. The kernel still edits only the keys whose value changes, so the
 * owner's comments survive, and whatever else the disk says (a broken value, an unreloaded hand edit) is overwritten
 * with the value in effect, never carried into effect.
 */
function wholeSettings(next: WardenConfig, inEffect: WardenFile): Record<string, unknown> {
  const stated = inEffect as Record<string, unknown>;
  const defaults = DEFAULT_WARDEN_CONFIG as unknown as Record<string, unknown>;
  const values = next as unknown as Record<string, unknown>;
  const keys: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    const value = values[key];
    const fallback = defaults[key];
    if (SECTIONS.includes(key) && isPlainObject(value) && isPlainObject(fallback)) {
      const had = isPlainObject(stated[key]) ? stated[key] : {};
      const section = Object.fromEntries(
        Object.entries(value).filter(([sub, inner]) => had[sub] !== undefined || !sameValue(inner, fallback[sub])),
      );
      keys[key] = Object.keys(section).length === 0 && stated[key] === undefined ? undefined : section;
    } else keys[key] = stated[key] !== undefined || !sameValue(value, fallback) ? value : undefined;
  }
  return keys;
}

/**
 * The settings, read from `config/warden.yaml` as the kernel has them in effect (the last good version) and written
 * through the kernel's config write port, which checks the schema, refuses a raw secret, keeps the comments and HOLDS a
 * loosening for the owner unless Gate's judge lets this call put it into effect. A save writes the WHOLE settings (the
 * ones in effect plus the owner's patch), so it can loosen only what the owner asked for. A save while another edit is
 * held is refused (`WardenConfigHeld`) and writes nothing.
 */
export class ConfigWardenConfigStore implements WardenConfigStore {
  constructor(private readonly config: ConfigPort) {}

  async read(): Promise<unknown> {
    return effectiveWardenConfig(this.config.file(WARDEN_CONFIG) ?? {});
  }

  async write(config: WardenConfig, _patch: WardenConfigPatch): Promise<readonly string[]> {
    if (this.config.fileState(WARDEN_CONFIG).state === 'held') throw new WardenConfigHeld();
    const inEffect = (this.config.file(WARDEN_CONFIG) ?? {}) as WardenFile;
    const result = await this.config.write(WARDEN_CONFIG, undefined, { patch: wholeSettings(config, inEffect) });
    if (result.kind === 'refused')
      throw new WardenConfigRefused(result.issues.map(issue => issue.message).join('; ') || result.reason);
    if (result.kind === 'conflict') throw new WardenConfigRefused('warden.yaml changed while it was being written');
    return result.kind === 'held' ? result.sentences : [];
  }
}
