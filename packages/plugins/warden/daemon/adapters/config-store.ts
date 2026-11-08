import type { ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
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
 * `warden.yaml` already holds an edit waiting for the owner, and this save names no setting, so there is nothing to make
 * to either version: it is refused before anything is written, the held edit stays held and the settings in effect
 * stay as they are.
 *
 * Today the owner's own save is made to BOTH versions (the one in effect and the held one), key by key inside a
 * section, so a tightening applies at once and a held edit is neither lost nor put into effect (docs/config-files.md
 * rule 3). On 5.0 that is the kernel's `ConfigPort.writeAsOwner`:
 * - a save while an edit is held sends only what the owner changed: a top-level setting (`enabled`, the minutes,
 *   `accounts`, …) whole, and of a section (`caps`, `guard`, `mayActAlone`, …) only the sub-keys it changed, with
 *   the section named in `within` so the kernel merges them one level deep into each version. The held version keeps
 *   its own sub-keys (the 2026-10-29 price incident) and stays held;
 * - a broken file is OVERWRITTEN with the value in effect: every setting is written from the settings in effect plus
 *   the owner's patch, so such an edit is never put into effect, but it is lost (today's fail-safe) (a file with a
 *   top-level key the schema does not know is refused instead; the owner repairs it by hand);
 * - a hand edit the kernel has not reloaded yet is not lost: the kernel refuses the write as moved since its last
 *   reload (`conflict`, `WardenConfigMoved`) and the owner saves again once it has been read.
 */
export class WardenConfigHeld extends Error {
  constructor() {
    super('warden.yaml has a change waiting for your approval; confirm or discard it first, then save again.');
    this.name = 'WardenConfigHeld';
  }
}

/** `warden.yaml` moved since the kernel last read it, so the save wrote nothing; saving again works from what it holds. */
export class WardenConfigMoved extends Error {
  constructor() {
    super('warden.yaml changed since it was last read; nothing was saved. Try again.');
    this.name = 'WardenConfigMoved';
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

/** Equality over the settings' values: a primitive, or an array of them (no default holds an object inside a section). */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
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
 * held goes to BOTH versions through `writeAsOwner`, a section merged sub-key by sub-key (see {@link WardenConfigHeld}).
 */
export class ConfigWardenConfigStore implements WardenConfigStore {
  constructor(private readonly config: ConfigPort) {}

  async read(): Promise<unknown> {
    return effectiveWardenConfig(this.config.file(WARDEN_CONFIG) ?? {});
  }

  async write(config: WardenConfig, patch: WardenConfigPatch): Promise<readonly string[]> {
    if (this.config.fileState(WARDEN_CONFIG).state === 'held') return await this.#writeBesideHeld(config, patch);
    const inEffect = (this.config.file(WARDEN_CONFIG) ?? {}) as WardenFile;
    return outcomeOf(await this.config.write(WARDEN_CONFIG, undefined, { patch: wholeSettings(config, inEffect) }));
  }

  /**
   * The owner's save while another edit of `warden.yaml` waits (docs/config-files.md rule 3): made to BOTH versions by
   * the kernel's `writeAsOwner`, which asks Gate's judge about the owner's patch alone, never about the held edit.
   * Only what the owner changed is sent, as `next` means it: a top-level key whole, and of a section only the sub-keys
   * the patch names, the section named in `within` so the kernel merges them one level deep into each version and the
   * held version keeps its own sub-keys.
   */
  async #writeBesideHeld(config: WardenConfig, patch: WardenConfigPatch): Promise<readonly string[]> {
    const named = patch as Record<string, unknown>;
    const keys = Object.keys(named).filter(key => named[key] !== undefined);
    // A save naming no key has nothing to make to either version; it is refused as before, writing nothing.
    if (keys.length === 0) throw new WardenConfigHeld();
    const values = config as unknown as Record<string, unknown>;
    const within = keys.filter(
      key => SECTIONS.includes(key) && isPlainObject(named[key]) && isPlainObject(values[key]),
    );
    const ownerPatch = Object.fromEntries(
      keys.map(key => {
        if (!within.includes(key)) return [key, values[key]];
        const section = values[key] as Record<string, unknown>;
        return [key, Object.fromEntries(Object.keys(named[key] as object).map(sub => [sub, section[sub]]))];
      }),
    );
    return outcomeOf(
      await this.config.writeAsOwner(WARDEN_CONFIG, undefined, {
        patch: ownerPatch,
        ...(within.length === 0 ? {} : { within }),
      }),
    );
  }
}

/** What a write came to, for the settings route: the sentences of what waits for the owner, or a refusal thrown. */
function outcomeOf(result: ConfigWriteOutcome): readonly string[] {
  if (result.kind === 'refused')
    throw new WardenConfigRefused(result.issues.map(issue => issue.message).join('; ') || result.reason);
  if (result.kind === 'conflict') throw new WardenConfigMoved();
  return result.kind === 'held' ? result.sentences : [];
}
