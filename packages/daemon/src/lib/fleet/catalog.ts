/**
 * Who uses what in a machine's account model: the one reading of "used by" that the catalogue shows
 * and every change refuses or warns with (K1, K7, P6, E20, E21), so a list and the refusal of a delete
 * can never count differently.
 *
 * Pure.
 */
import {
  type AccountModel,
  flattenProfile,
  type LayerReferenceText,
  wouldIncludeItself,
} from '@ferretry/fleet';

const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Who uses one component or profile. */
export interface CatalogUsage {
  /** Profiles that have it as one of their own layers. */
  readonly direct: readonly string[];
  /** Profiles whose stack reaches it, directly or through a base. */
  readonly profiles: readonly string[];
  /** Runtimes whose profile reaches it. */
  readonly runtimes: readonly string[];
}

const runtimesOn = (model: AccountModel, profiles: ReadonlySet<string>): readonly string[] =>
  Object.entries(model.runtimes)
    .filter(([, runtime]) => profiles.has(runtime.profile))
    .map(([name]) => name)
    .toSorted(byName);

/** Who uses the component `reference` (`<kind>/<name>`). */
export function componentUsage(model: AccountModel, reference: LayerReferenceText): CatalogUsage {
  const direct = Object.entries(model.profiles)
    .filter(([, profile]) => profile.layers.includes(reference))
    .map(([name]) => name)
    .toSorted(byName);
  const profiles = Object.keys(model.profiles)
    .filter(name => {
      const flat = flattenProfile(model, name);
      return flat.ok && flat.layers.some(layer => layer.reference === reference);
    })
    .toSorted(byName);
  return { direct, profiles, runtimes: runtimesOn(model, new Set(profiles)) };
}

/**
 * Who uses the profile `name`: the profiles that name it as a base, the profiles whose stack reaches
 * it, and the runtimes on any of those or on it.
 */
export function profileUsage(model: AccountModel, name: string): CatalogUsage {
  const base = `profile/${name}`;
  const direct = Object.entries(model.profiles)
    .filter(([, profile]) => profile.layers.includes(base as LayerReferenceText))
    .map(([other]) => other)
    .toSorted(byName);
  const profiles = Object.keys(model.profiles)
    .filter(other => other !== name && wouldIncludeItself(model.profiles, name, other))
    .toSorted(byName);
  return { direct, profiles, runtimes: runtimesOn(model, new Set([name, ...profiles])) };
}

/** The runtimes that name `profile` themselves, which a delete must move (P6). */
export const runtimesUsingProfile = (model: AccountModel, profile: string): readonly string[] =>
  runtimesOn(model, new Set([profile]));

/** The runtimes on one credential (C10). */
export const runtimesUsingCredential = (model: AccountModel, credential: string): readonly string[] =>
  Object.entries(model.runtimes)
    .filter(([, runtime]) => runtime.credential === credential)
    .map(([name]) => name)
    .toSorted(byName);

/** "1 profile", "3 runtimes". */
export const counted = (count: number, singular: string, pluralWord = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralWord}`;

/** "a, b and c". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
}

/** E20: what an edit says about where it lands, or nothing when nobody else uses it. */
export function editConsequence(usage: CatalogUsage): string | undefined {
  if (usage.profiles.length === 0 && usage.runtimes.length === 0) return undefined;
  return `Used by ${counted(usage.profiles.length, 'profile')} and ${counted(usage.runtimes.length, 'runtime')}. Saving changes it everywhere. Running sessions keep the old version until restarted.`;
}
